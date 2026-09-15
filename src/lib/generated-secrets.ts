import { randomBytes } from "crypto";

import { log } from "./logger";
import { parseManifest } from "./manifest";
import type { DeploymentProvider } from "./providers/deployment";
import { envTargetResolver } from "./targets";

// Project-owned generated secrets (#88): variables declared `generate: true` in
// the manifest that envctl itself mints — a strong random value per environment,
// pushed to the deployment target, never stored in git. The motivating case is a
// Vercel-cron `CRON_SECRET`.

// One strong built-in format, no knobs (v1): 32 random bytes, base64url-encoded.
export function generateSecretValue(): string {
  return randomBytes(32).toString("base64url");
}

export interface GeneratedSecret {
  name: string;
  /** The distinct provider targets this secret is scoped to. */
  targets: string[];
}

// Resolve the manifest's `generate: true` variables into (name → target set),
// honoring variable-group environment scoping: a top-level generated variable
// applies to every environment; one inside a scoped group applies only to the
// group's environments. Each environment maps to its provider target
// (`resolveEnvTarget`); duplicate targets collapse. A project with no manifest
// (or no generated variables) yields an empty list — a no-op.
export function resolveGeneratedSecrets(
  deploymentDir: string,
): GeneratedSecret[] {
  const manifest = parseManifest(deploymentDir);
  const resolveTarget = envTargetResolver(deploymentDir);
  const secrets: GeneratedSecret[] = [];

  const record = (name: string, environments: readonly string[]): void => {
    const targets = [...new Set(environments.map((env) => resolveTarget(env)))];
    if (targets.length > 0) secrets.push({ name, targets });
  };

  for (const variable of manifest.variables)
    if (variable.source.kind === "generate")
      record(variable.name, manifest.environments);

  for (const group of manifest.variableGroups) {
    const environments = group.environments ?? manifest.environments;
    for (const variable of group.variables)
      if (variable.source.kind === "generate")
        record(variable.name, environments);
  }

  return secrets;
}

export interface GeneratedSecretPushOptions {
  /** rotate re-mints every value; init only fills targets that lack one. */
  overwrite: boolean;
  /** The run's requested environment target ("all" or a specific target). */
  targetEnv: string;
}

// Mint and push generated secrets to their scoped targets, minting a **distinct**
// value per target. On init (`overwrite: false`) a target that already has the
// value is left untouched (idempotent); on rotate (`overwrite: true`) every
// scoped target gets a fresh value. Returns whether anything was written (so the
// caller can decide whether a redeploy is needed). Does not redeploy itself.
export async function pushGeneratedSecrets(
  deployment: DeploymentProvider,
  secrets: GeneratedSecret[],
  opts: GeneratedSecretPushOptions,
): Promise<boolean> {
  if (secrets.length === 0) return false;

  const { envs } = await deployment.listEnvVars();
  let wrote = false;

  for (const secret of secrets) {
    for (const target of secret.targets) {
      if (opts.targetEnv !== "all" && target !== opts.targetEnv) continue;
      const existing = deployment.findEnvVar(envs, secret.name, target);
      if (existing && !opts.overwrite) continue;
      await deployment.setEnvForTarget(
        secret.name,
        generateSecretValue(),
        target,
        envs,
        "encrypted",
      );
      log(
        `  [${target}] ${existing ? "Rotated" : "Minted"} generated secret ${secret.name}`,
      );
      wrote = true;
    }
  }

  return wrote;
}
