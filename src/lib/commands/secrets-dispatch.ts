import type { FirebaseCredentialSpec } from "../firebase-credential";
import { parseDeploymentEnv } from "../environments";
import {
  pushGeneratedSecrets,
  type GeneratedSecret,
} from "../generated-secrets";
import { githubAppConfigFor } from "../github-app";
import { resolveGithubSecrets, withGithubSecretSync } from "../github-secrets";
import type { DeploymentProvider } from "../providers/deployment";
import { resolveProjectDeployment } from "../providers/registry";
import { serviceProviders, type ServiceContext } from "../providers/service";
import { run as rotateKeysRun } from "../rotation";
import { assertProviderAuth } from "../rotation-preflight";
import { envTargetResolver } from "../targets";
import type { SecretsOptions } from "./secrets-args";
import { sentrySourceEnv } from "./secrets-plan";

// Turning resolved `secrets` options into rotation-engine calls: which
// providers get one call per target versus one project-wide call, and how
// generated secrets share the providers' redeploy.

// Dispatches the rotation engine, mirroring the predecessor's key-rotation
// orchestration: on `init --env all`, Sentry is initialized once (project-wide)
// while Firebase is initialized per Vercel target (each gets its own key, with
// development sourced from staging); otherwise a single engine call handles the
// requested environment (rotation auto-detects services from existing keys).
export async function dispatchRotation(
  opts: SecretsOptions,
  init: SecretsOptions["provider"] | "all" | undefined,
  envList: string[],
  devSource: string | undefined,
  firebaseCredential: FirebaseCredentialSpec,
): Promise<void> {
  const { deploymentDir, invalidateKeys, workingDir, targetEnv } = opts;
  const resolveTarget = envTargetResolver(deploymentDir);
  const { githubAppPrivateKeyFile } = opts;

  if (init && targetEnv === "all") {
    // A GitHub App has one webhook config, so it is initialized once across
    // every target its service is scoped to.
    if (init === "github-app")
      await rotateKeysRun({
        targetEnv: "all",
        invalidateKeys,
        workingDir,
        deploymentDir,
        init,
        githubAppPrivateKeyFile,
      });
    if (init === "sentry" || init === "all") {
      const source = sentrySourceEnv("all", envList, devSource);
      const vars = source ? parseDeploymentEnv(deploymentDir, source) : {};
      await rotateKeysRun({
        targetEnv: "all",
        invalidateKeys,
        workingDir,
        deploymentDir,
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
          deploymentDir,
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
          deploymentDir,
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
    deploymentDir,
    init,
    // provider scopes rotate mode only; it is inert when init is set.
    provider: init ? undefined : opts.provider,
    firebaseSaEmail: vars.FIREBASE_SA_EMAIL || undefined,
    gcpProject: vars.FIREBASE_PROJECT_ID || undefined,
    firebaseCredential,
    sentryOrg: vars.SENTRY_ORG || undefined,
    sentryProject: vars.SENTRY_PROJECT || undefined,
    githubAppPrivateKeyFile,
  });
}

// Whether any secret-source provider is provisioned in Vercel — the rotate-mode
// signal for whether the provider dispatch has work to do (so a project with
// only generated secrets doesn't hit the engine's "nothing to rotate" guard).
async function anyServicePresent(
  deployment: DeploymentProvider,
  firebaseCredential: FirebaseCredentialSpec,
  deploymentDir: string,
): Promise<boolean> {
  const keys = new Set((await deployment.listEnvVars()).envs.map((e) => e.key));
  const ctx: ServiceContext = {
    targetEnv: "all",
    deployment,
    tempDir: "",
    firebaseCredential,
    githubApp: githubAppConfigFor(deploymentDir),
  };
  // Manual-only providers (manualSteps) never give the engine work to do.
  return serviceProviders().some(
    (p) => !p.manualSteps && p.presenceKeys(ctx).some((k) => keys.has(k)),
  );
}

// Drive a run that includes project-owned generated secrets (#88). Generated
// values are minted and pushed first (no redeploy), then the provider dispatch
// runs when there is provider work — its redeploy proves the generated values
// live too, so they share one redeploy. When only generated secrets exist (no
// provider work), a redeploy is triggered here instead.
export async function runWithGeneratedSecrets(
  opts: SecretsOptions,
  init: SecretsOptions["provider"] | "all" | undefined,
  isInit: boolean,
  envList: string[],
  devSource: string | undefined,
  firebaseCredential: FirebaseCredentialSpec,
  generated: GeneratedSecret[],
): Promise<void> {
  const runTarget =
    opts.targetEnv === "all"
      ? "all"
      : envTargetResolver(opts.deploymentDir)(opts.targetEnv);
  // Generated values with a declared GitHub secret are mirrored too (#198);
  // assert gh auth before anything is minted.
  const githubTargets = resolveGithubSecrets(opts.deploymentDir).filter(
    (t) =>
      (runTarget === "all" || t.target === runTarget) &&
      generated.some((g) => g.name === t.variable),
  );
  if (githubTargets.length > 0)
    assertProviderAuth({ firebase: false, sentry: false, github: true });
  const deployment = withGithubSecretSync(
    resolveProjectDeployment(opts.deploymentDir, opts.workingDir),
    githubTargets,
  );

  const wrote = await pushGeneratedSecrets(deployment, generated, {
    overwrite: !isInit,
    targetEnv: runTarget,
  });

  const providerWork = isInit
    ? init !== undefined
    : await anyServicePresent(
        deployment,
        firebaseCredential,
        opts.deploymentDir,
      );

  if (providerWork) {
    await dispatchRotation(opts, init, envList, devSource, firebaseCredential);
  } else if (wrote) {
    await deployment.triggerAndWaitRedeployments(runTarget);
  }
}
