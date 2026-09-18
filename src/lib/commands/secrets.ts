import { resolveVercelToken } from "../auth";
import type { CommandContext } from "../cli/registry";
import { refreshPreviewDeployments } from "../deployments";
import {
  resolveFirebaseCredential,
  type FirebaseCredentialSpec,
} from "../firebase-credential";
import {
  pushGeneratedSecrets,
  resolveGeneratedSecrets,
  type GeneratedSecret,
} from "../generated-secrets";
import { parseManifest } from "../manifest";
import { listActiveEnvs, parseDeploymentEnv } from "../environments";
import { err, log } from "../logger";
import type { DeploymentProvider } from "../providers/deployment";
import { resolveProjectDeployment } from "../providers/registry";
import { serviceProviders, type ServiceContext } from "../providers/service";
import { detectProject } from "../project";
import { run as rotateKeysRun } from "../rotation";
import { envTargetResolver } from "../targets";
import { VercelClient } from "../vercel-api";
import {
  assertDeploymentPrereqs,
  findDevSource,
  resolveEnvList,
} from "./env-plan";
import { parseSecretsArgs, type SecretsOptions } from "./secrets-args";
import {
  detectConfiguredServices,
  resolveAutoInit,
  sentrySourceEnv,
  validateInitConfig,
} from "./secrets-plan";

export type { SecretsOptions };

// Dispatches the rotation engine, mirroring the predecessor's key-rotation
// orchestration: on `init --env all`, Sentry is initialized once (project-wide)
// while Firebase is initialized per Vercel target (each gets its own key, with
// development sourced from staging); otherwise a single engine call handles the
// requested environment (rotation auto-detects services from existing keys).
async function dispatchRotation(
  opts: SecretsOptions,
  init: "all" | "firebase" | "sentry" | undefined,
  envList: string[],
  devSource: string | undefined,
  firebaseCredential: FirebaseCredentialSpec,
): Promise<void> {
  const { deploymentDir, invalidateKeys, workingDir, targetEnv } = opts;
  const resolveTarget = envTargetResolver(deploymentDir);

  if (init && targetEnv === "all") {
    if (init === "sentry" || init === "all") {
      const source = sentrySourceEnv("all", envList, devSource);
      const vars = source ? parseDeploymentEnv(deploymentDir, source) : {};
      await rotateKeysRun({
        targetEnv: "all",
        invalidateKeys,
        workingDir,
        init: "sentry",
        sentryOrg: vars.SENTRY_ORG || undefined,
        sentryProject: vars.SENTRY_PROJECT || undefined,
      });
    }
    if (init === "firebase" || init === "all") {
      const seenTargets = new Set<string>();
      for (const envName of envList) {
        const target = resolveTarget(envName);
        if (seenTargets.has(target)) continue;
        seenTargets.add(target);
        const vars = parseDeploymentEnv(deploymentDir, envName);
        await rotateKeysRun({
          targetEnv: target,
          invalidateKeys,
          workingDir,
          init: "firebase",
          firebaseSaEmail: vars.FIREBASE_SA_EMAIL || undefined,
          gcpProject: vars.FIREBASE_PROJECT_ID || undefined,
          firebaseCredential,
        });
      }
      // development shares staging's Firebase project but gets its own key.
      if (devSource) {
        const vars = parseDeploymentEnv(deploymentDir, devSource);
        await rotateKeysRun({
          targetEnv: "development",
          invalidateKeys,
          workingDir,
          init: "firebase",
          firebaseSaEmail: vars.FIREBASE_SA_EMAIL || undefined,
          gcpProject: vars.FIREBASE_PROJECT_ID || undefined,
          firebaseCredential,
        });
      }
    }
    return;
  }

  const source =
    targetEnv === "development"
      ? devSource
      : targetEnv === "all"
        ? envList[0]
        : targetEnv;
  const vars = source ? parseDeploymentEnv(deploymentDir, source) : {};
  await rotateKeysRun({
    targetEnv: targetEnv === "all" ? "all" : resolveTarget(targetEnv),
    invalidateKeys,
    workingDir,
    init,
    // provider scopes rotate mode only; it is inert when init is set.
    provider: init ? undefined : opts.provider,
    firebaseSaEmail: vars.FIREBASE_SA_EMAIL || undefined,
    gcpProject: vars.FIREBASE_PROJECT_ID || undefined,
    firebaseCredential,
    sentryOrg: vars.SENTRY_ORG || undefined,
    sentryProject: vars.SENTRY_PROJECT || undefined,
  });
}

// Whether any secret-source provider is provisioned in Vercel — the rotate-mode
// signal for whether the provider dispatch has work to do (so a project with
// only generated secrets doesn't hit the engine's "nothing to rotate" guard).
async function anyServicePresent(
  deployment: DeploymentProvider,
  firebaseCredential: FirebaseCredentialSpec,
): Promise<boolean> {
  const keys = new Set((await deployment.listEnvVars()).envs.map((e) => e.key));
  const ctx: ServiceContext = {
    targetEnv: "all",
    deployment,
    tempDir: "",
    firebaseCredential,
  };
  return serviceProviders().some((p) =>
    p.presenceKeys(ctx).some((k) => keys.has(k)),
  );
}

// Drive a run that includes project-owned generated secrets (#88). Generated
// values are minted and pushed first (no redeploy), then the provider dispatch
// runs when there is provider work — its redeploy proves the generated values
// live too, so they share one redeploy. When only generated secrets exist (no
// provider work), a redeploy is triggered here instead.
async function runWithGeneratedSecrets(
  opts: SecretsOptions,
  init: "all" | "firebase" | "sentry" | undefined,
  isInit: boolean,
  envList: string[],
  devSource: string | undefined,
  firebaseCredential: FirebaseCredentialSpec,
  generated: GeneratedSecret[],
): Promise<void> {
  const deployment = resolveProjectDeployment(
    opts.deploymentDir,
    opts.workingDir,
  );
  const runTarget =
    opts.targetEnv === "all"
      ? "all"
      : envTargetResolver(opts.deploymentDir)(opts.targetEnv);

  const wrote = await pushGeneratedSecrets(deployment, generated, {
    overwrite: !isInit,
    targetEnv: runTarget,
  });

  const providerWork = isInit
    ? init !== undefined
    : await anyServicePresent(deployment, firebaseCredential);

  if (providerWork) {
    await dispatchRotation(opts, init, envList, devSource, firebaseCredential);
  } else if (wrote) {
    await deployment.triggerAndWaitRedeployments(runTarget);
  }
}

// Orchestrates `secrets rotate` / `secrets init` from fully-resolved options:
// validates prerequisites, resolves the environment plan (and, for init, the
// concrete service + its required config), drives the rotation engine, and
// optionally refreshes active PR previews.
export async function runSecrets(opts: SecretsOptions): Promise<void> {
  const token = resolveVercelToken();
  assertDeploymentPrereqs(opts.deploymentDir, token);

  const activeEnvs = listActiveEnvs(opts.deploymentDir);
  if (activeEnvs.length === 0)
    err(
      `No active environments found in ${opts.deploymentDir}/environments.yml`,
    );

  const devSource = findDevSource(opts.deploymentDir, activeEnvs);
  const envList = resolveEnvList(activeEnvs, opts.targetEnv, devSource);

  const generated = resolveGeneratedSecrets(opts.deploymentDir);
  const isInit = opts.init !== undefined;

  let init = opts.init;
  if (init === "auto") {
    // Auto-detect the provider(s) to initialize. A project with only generated
    // secrets (no Firebase/Sentry config) has no provider to init but is not an
    // error — it proceeds to mint its generated secrets.
    const configured = detectConfiguredServices(
      opts.deploymentDir,
      opts.targetEnv,
      envList,
      devSource,
    );
    if (!configured.firebase && !configured.sentry) {
      if (generated.length === 0)
        err(
          "secrets init: nothing to initialize — no Firebase or Sentry public config vars found in the deployment config",
        );
      init = undefined;
    } else {
      init = resolveAutoInit(
        opts.deploymentDir,
        opts.targetEnv,
        envList,
        devSource,
      );
    }
  }
  if (init)
    validateInitConfig(
      init,
      opts.deploymentDir,
      opts.targetEnv,
      envList,
      devSource,
    );

  // Resolve the Firebase credential contract from the manifest (the resolved
  // var names). With no manifest / no firebase service declared, this is the
  // default names.
  const firebaseService = parseManifest(opts.deploymentDir).services.find(
    (s) => s.provider === "firebase",
  );
  const firebaseCredential = resolveFirebaseCredential(firebaseService);

  log(
    `Target: ${opts.targetEnv} | ${isInit ? `Initializing${init ? ` ${init}` : ""}` : `Rotating (invalidate old: ${opts.invalidateKeys})`}`,
  );
  if (generated.length === 0) {
    await dispatchRotation(opts, init, envList, devSource, firebaseCredential);
  } else {
    await runWithGeneratedSecrets(
      opts,
      init,
      isInit,
      envList,
      devSource,
      firebaseCredential,
      generated,
    );
  }

  if (opts.refreshPreviews) {
    const project = detectProject(opts.workingDir);
    const client = new VercelClient(token, project.projectId, project.teamId);
    await refreshPreviewDeployments(client);
  }
}

// Command adapters: parse args (the global -C is already stripped by the
// router) and dispatch to the shared orchestrator.
export async function runSecretsRotate(
  ctx: CommandContext,
  args: string[],
): Promise<void> {
  await runSecrets(parseSecretsArgs(args, ctx.workingDir, false));
}

export async function runSecretsInit(
  ctx: CommandContext,
  args: string[],
): Promise<void> {
  await runSecrets(parseSecretsArgs(args, ctx.workingDir, true));
}
