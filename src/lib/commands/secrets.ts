import { resolveVercelToken } from "../auth";
import type { CommandContext } from "../cli/registry";
import { refreshPreviewDeployments } from "../deployments";
import { resolveFirebaseCredential } from "../firebase-credential";
import { resolveGeneratedSecrets } from "../generated-secrets";
import { parseManifest } from "../manifest";
import { listActiveEnvs } from "../environments";
import { err, log } from "../logger";
import { posthogManualSteps, posthogVarsFor } from "../posthog";
import { detectProject } from "../project";
import { VercelClient } from "../vercel-api";
import {
  assertDeploymentPrereqs,
  findDevSource,
  resolveEnvList,
} from "./env-plan";
import { parseSecretsArgs, type SecretsOptions } from "./secrets-args";
import { dispatchRotation, runWithGeneratedSecrets } from "./secrets-dispatch";
import {
  detectConfiguredServices,
  resolveAutoInit,
  validateInitConfig,
} from "./secrets-plan";

export type { SecretsOptions };

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
    if (!configured.firebase && !configured.sentry && !configured.githubApp) {
      if (generated.length === 0)
        err(
          "secrets init: nothing to initialize — no Firebase or Sentry public config vars or github-app service found in the deployment config",
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
  // PostHog's personal API key can't be minted or deleted via its API: refuse
  // a named init/rotate with the manual steps before anything — generated
  // secrets included — is written.
  if (init === "posthog" || opts.provider === "posthog")
    err(posthogManualSteps(posthogVarsFor(opts.deploymentDir)));
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
