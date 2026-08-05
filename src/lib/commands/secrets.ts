import { resolveVercelToken } from "../auth";
import type { CommandContext } from "../cli/registry";
import { refreshPreviewDeployments } from "../deployments";
import {
  listActiveEnvs,
  parseDeploymentEnv,
  vercelTarget,
} from "../environments";
import { err, log } from "../logger";
import { detectProject } from "../project";
import { run as rotateKeysRun } from "../rotation";
import { VercelClient } from "../vercel-api";
import {
  assertDeploymentPrereqs,
  findDevSource,
  resolveEnvList,
} from "./env-plan";
import { parseSecretsArgs, type SecretsOptions } from "./secrets-args";
import {
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
): Promise<void> {
  const { deploymentDir, invalidateKeys, workingDir, targetEnv } = opts;

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
      for (const envName of envList) {
        const vars = parseDeploymentEnv(deploymentDir, envName);
        await rotateKeysRun({
          targetEnv: vercelTarget(envName),
          invalidateKeys,
          workingDir,
          init: "firebase",
          firebaseSaEmail: vars.FIREBASE_SA_EMAIL || undefined,
          gcpProject: vars.FIREBASE_PROJECT_ID || undefined,
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
    targetEnv: targetEnv === "all" ? "all" : vercelTarget(targetEnv),
    invalidateKeys,
    workingDir,
    init,
    firebaseSaEmail: vars.FIREBASE_SA_EMAIL || undefined,
    gcpProject: vars.FIREBASE_PROJECT_ID || undefined,
    sentryOrg: vars.SENTRY_ORG || undefined,
    sentryProject: vars.SENTRY_PROJECT || undefined,
  });
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

  const devSource = findDevSource(activeEnvs);
  const envList = resolveEnvList(activeEnvs, opts.targetEnv, devSource);

  let init = opts.init;
  if (init === "auto")
    init = resolveAutoInit(
      opts.deploymentDir,
      opts.targetEnv,
      envList,
      devSource,
    );
  if (init)
    validateInitConfig(
      init,
      opts.deploymentDir,
      opts.targetEnv,
      envList,
      devSource,
    );

  log(
    `Target: ${opts.targetEnv} | ${init ? `Initializing ${init}` : `Rotating (invalidate old: ${opts.invalidateKeys})`}`,
  );
  await dispatchRotation(opts, init, envList, devSource);

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
