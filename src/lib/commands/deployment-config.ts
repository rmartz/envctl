import * as fs from "fs";
import * as path from "path";

import * as yaml from "js-yaml";

// The deploy targets `env add` accepts. The name→target mapping itself is the
// ported engine's convention (see vercelTarget); this is the validated set a
// caller may declare for an environment.
export const VALID_TARGETS = ["production", "preview", "development"] as const;
export type DeployTarget = (typeof VALID_TARGETS)[number];

export function isValidTarget(value: string): value is DeployTarget {
  return (VALID_TARGETS as readonly string[]).includes(value);
}

export function deploymentDir(workingDir: string): string {
  return path.join(workingDir, "deployment");
}

export function environmentsFile(workingDir: string): string {
  return path.join(deploymentDir(workingDir), "environments.yml");
}

export function envFile(workingDir: string, name: string): string {
  return path.join(deploymentDir(workingDir), `${name}.yml`);
}

// Reserializes environments.yml from the active list. Per the recorded design
// decision this is a load→mutate→dump round-trip, so comments and key ordering
// in an existing file are not preserved.
export function writeActiveEnvs(workingDir: string, active: string[]): void {
  fs.writeFileSync(environmentsFile(workingDir), yaml.dump({ active }));
}

// Writes a per-environment file in the nested format
// ({ environment, variables }), the form `init`/`env add` scaffold.
export function writeEnvFile(
  workingDir: string,
  name: string,
  variables: Record<string, string>,
): void {
  fs.writeFileSync(
    envFile(workingDir, name),
    yaml.dump({ environment: name, variables }),
  );
}
