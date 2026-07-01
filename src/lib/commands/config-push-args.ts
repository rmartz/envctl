import * as path from "path";

import { err } from "../logger";

// Resolved options for `config push`. `deploymentDir` is absolute (resolved
// against the project root) by the time it reaches `runPush`.
export interface PushOptions {
  // Environment to push: a name from environments.yml, "development" for the
  // implicit development target, or "all" (the default).
  targetEnv: string;
  // Absolute project root, used to resolve `.vercel/project.json`. Resolved
  // from the global -C/--working-dir flag (or CWD) by the router.
  workingDir: string;
  // Absolute path to the deployment config directory.
  deploymentDir: string;
  // When true, print the intended plan without making any Vercel API calls.
  dryRun: boolean;
}

export const PUSH_USAGE = `Usage: envctl config push [OPTIONS]

Upsert public (non-secret) environment variables to a Vercel project from
deployment configuration files. Reads the list of active environments from
<deployment-dir>/environments.yml and per-environment values from
<deployment-dir>/{env}.yml.

The development Vercel target is always populated from the same YAML source as
the staging/preview environment. It does not appear in environments.yml and has
no dedicated YAML file. Existing variables are updated in place; missing ones
are created as plain-type records. Variables not present in the config files are
left untouched.

OPTIONS:
  --env <name>             Target a specific environment by name as listed in
                           environments.yml, or 'development' for the implicit
                           development target (default: all active environments
                           plus development)
  --deployment-dir <path>  Path to the deployment config directory, resolved
                           against the project root (default: deployment)
  --dry-run                Print what would change without making any API calls
  -h, --help               Show this help

ENVIRONMENT MAPPING:
  production  → production (Vercel target)
  staging     → preview   (Vercel target)
  preview     → preview   (Vercel target)
  development → development (implicit — mirrors staging/preview)
  <other>     → passed through as-is`;

// Parses the `config push` argument list. `args` has already had the global
// -C/--working-dir flag stripped by the router. The (absolute) project root is
// used to resolve the default and relative --deployment-dir values. Prints
// usage and exits 0 on -h/--help.
export function parsePushArgs(args: string[], workingDir: string): PushOptions {
  let targetEnv = "all";
  let deploymentDir = "deployment";
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--env") {
      targetEnv =
        args[++i] ?? err('--env requires an environment name or "all"');
      if (!targetEnv) err('--env requires an environment name or "all"');
    } else if (arg === "--deployment-dir") {
      deploymentDir = args[++i] ?? err("--deployment-dir requires a path");
      if (!deploymentDir) err("--deployment-dir requires a path");
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(PUSH_USAGE);
      process.exit(0);
    } else {
      err(`Unknown option: ${arg}. Run 'envctl config push --help' for usage.`);
    }
  }

  return {
    targetEnv,
    workingDir,
    deploymentDir: path.resolve(workingDir, deploymentDir),
    dryRun,
  };
}
