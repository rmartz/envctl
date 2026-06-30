import type { SpawnSyncOptions } from "child_process";
import { spawnSync } from "child_process";

export function run(
  cmd: string,
  args: string[],
  opts?: SpawnSyncOptions,
): string {
  const result = spawnSync(cmd, args, { encoding: "utf-8", ...opts });
  if (result.error)
    throw new Error(`Failed to run ${cmd}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `${cmd} exited with code ${String(result.status)}: ${String(result.stderr)}`,
    );
  }
  return String(result.stdout);
}

export function commandExists(cmd: string): boolean {
  const result = spawnSync("which", [cmd]);
  return result.status === 0;
}
