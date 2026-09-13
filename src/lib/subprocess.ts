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

// Like `run`, but returns the exit status instead of throwing on a non-zero
// exit — for callers that treat the code itself as data (e.g. `git check-ignore`,
// where 0 = ignored, 1 = not ignored, 128 = not a repo). A failure to spawn the
// process at all still throws; guard with `commandExists` when that matters.
export function runStatus(
  cmd: string,
  args: string[],
  opts?: SpawnSyncOptions,
): { status: number | null; stdout: string } {
  const result = spawnSync(cmd, args, { encoding: "utf-8", ...opts });
  if (result.error)
    throw new Error(`Failed to run ${cmd}: ${result.error.message}`);
  return { status: result.status, stdout: String(result.stdout ?? "") };
}
