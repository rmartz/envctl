import * as path from "path";

import { err } from "../logger";

// Resolved options for `envctl bootstrap`. `deploymentDir` and `out` are
// absolute (resolved against the project root) by the time they reach the
// orchestrator.
export interface BootstrapOptions {
  // Environment(s) the public-config and secrets phases act on: a name from
  // environments.yml, "development", or "all" (the default).
  targetEnv: string;
  // Absolute project root, used to resolve `.vercel/project.json` and paths.
  workingDir: string;
  // Absolute path to the deployment config directory.
  deploymentDir: string;
  // When true, print the plan for every phase without making any changes.
  dryRun: boolean;
  // When false (`--no-pull`), skip materializing the local dotenv file.
  pull: boolean;
  // Absolute path of the dotenv file the pull phase writes.
  out: string;
}

export const BOOTSTRAP_USAGE = `Usage: envctl bootstrap [OPTIONS]

Configure a project end to end in one pass: push public environment variables,
initialize any provider secrets that are not yet present, then materialize a
local dotenv file for development. Idempotent — safe to re-run: public vars are
upserted, and a secret that already exists is left in place (use
'envctl secrets rotate' to rotate it) rather than re-initialized.

Preconditions: a linked Vercel project (.vercel/project.json, from
'vercel link'), the Vercel CLI on PATH, an authenticated gcloud for Firebase,
and a Sentry token for Sentry. Run 'envctl auth status' to check.

OPTIONS:
  --env <name|all>         Environment(s) for the public-config and secrets
                           phases (default: all)
  --deployment-dir <path>  Path to the deployment config directory, resolved
                           against the project root (default: deployment)
  --out <path>             Dotenv file the pull phase writes, resolved against
                           the project root (default: .env.local)
  --no-pull                Skip the local dotenv pull phase
  --dry-run                Print the plan for every phase without making changes
  -h, --help               Show this help`;

// Parses `bootstrap` args (the global -C/--working-dir flag is already stripped
// by the router). Prints usage and exits 0 on -h/--help.
export function parseBootstrapArgs(
  args: string[],
  workingDir: string,
): BootstrapOptions {
  let targetEnv = "all";
  let deploymentDir = "deployment";
  let dryRun = false;
  let pull = true;
  let out = ".env.local";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--env") {
      targetEnv =
        args[++i] ?? err('--env requires an environment name or "all"');
      if (!targetEnv) err('--env requires an environment name or "all"');
    } else if (arg === "--deployment-dir") {
      deploymentDir = args[++i] ?? err("--deployment-dir requires a path");
      if (!deploymentDir) err("--deployment-dir requires a path");
    } else if (arg === "--out") {
      out = args[++i] ?? err("--out requires a path");
      if (!out) err("--out requires a path");
    } else if (arg === "--no-pull") {
      pull = false;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(BOOTSTRAP_USAGE);
      process.exit(0);
    } else {
      err(`Unknown option: ${arg}. Run 'envctl bootstrap --help' for usage.`);
    }
  }

  return {
    targetEnv,
    workingDir,
    deploymentDir: path.resolve(workingDir, deploymentDir),
    dryRun,
    pull,
    out: path.resolve(workingDir, out),
  };
}
