import * as fs from "fs";
import * as path from "path";

import { err } from "../logger";
import { envTargetResolver } from "../targets";

// Environment-planning helpers shared by `config push` and `secrets` — the
// logic that turns a requested --env value plus the active-environments list
// into the concrete set of named environments a command acts on.

// Preflight shared by the deployment-config commands: a Vercel token must
// resolve and the deployment directory (with its environments.yml) must exist.
// Narrows `token` to a string for the caller.
export function assertDeploymentPrereqs(
  deploymentDir: string,
  token: string | undefined,
): asserts token is string {
  if (!token)
    err(
      "No Vercel token found. Set VERCEL_TOKEN or run 'vercel login' to authenticate.",
    );
  if (!fs.existsSync(deploymentDir))
    err(`Deployment directory not found: ${deploymentDir}`);
  const envsFile = path.join(deploymentDir, "environments.yml");
  if (!fs.existsSync(envsFile)) err(`environments.yml not found: ${envsFile}`);
}

// Returns the first active env whose provider target is "preview" (i.e.
// staging), resolved from the manifest's authoritative targets map (#87) rather
// than inferred from the name convention. The implicit development target
// mirrors this source (public vars for `config push`; the shared Firebase
// project for `secrets`), so a project can now designate the dev source by
// declaring a `preview` target for a non-conventionally-named env.
export function findDevSource(
  deploymentDir: string,
  activeEnvs: string[],
): string | undefined {
  const resolveTarget = envTargetResolver(deploymentDir);
  return activeEnvs.find((e) => resolveTarget(e) === "preview");
}

// Resolves the concrete list of named environments from the requested --env:
// "all" → every active env; "development" → none (the implicit development
// target is handled separately and requires a devSource); otherwise the single
// named env, validated against the active list. Errors (via `err`) on an
// unknown --env or on "development" with no staging/preview source.
export function resolveEnvList(
  activeEnvs: string[],
  targetEnv: string,
  devSource: string | undefined,
): string[] {
  if (targetEnv === "all") return activeEnvs;
  if (targetEnv === "development") {
    if (!devSource)
      err(
        "--env development requires a staging or preview environment in environments.yml",
      );
    return [];
  }
  if (!activeEnvs.includes(targetEnv))
    err(
      `--env '${targetEnv}' not in active environments: ${activeEnvs.join(", ")}`,
    );
  return [targetEnv];
}
