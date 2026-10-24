import * as path from "path";

import { err } from "../logger";

// Resolved options for `secrets rotate` / `secrets init`. `deploymentDir` is
// absolute (resolved against the project root) by the time it reaches the
// orchestrator. `init` is undefined for `rotate`; for `init` it is the target
// service, or "auto" to auto-detect from the deployment config.
export interface SecretsOptions {
  // Environment to act on: a name from environments.yml, "development" for the
  // implicit development target, or "all" (the default).
  targetEnv: string;
  // Absolute project root, used to resolve `.vercel/project.json`.
  workingDir: string;
  // Absolute path to the deployment config directory.
  deploymentDir: string;
  // When false (`--no-invalidate`), old keys are kept after the redeploy.
  invalidateKeys: boolean;
  // When true (`--refresh-previews`), active PR previews are redeployed after
  // rotation so their warm instances pick up the new credential.
  refreshPreviews: boolean;
  // Bootstrap mode: undefined = rotate existing secrets; "auto" = detect from
  // deployment config; otherwise the specific service to initialize.
  init?: "all" | "auto" | "firebase" | "sentry" | "posthog" | "github-app";
  // Rotate mode only: restrict the run to a single provider (the leading
  // firebase|sentry|posthog|github-app positional). Undefined rotates every
  // present provider.
  provider?: "firebase" | "sentry" | "posthog" | "github-app";
  // `--private-key-file`: the GitHub App private key PEM (#201). The path is
  // the only thing envctl takes on the command line; the key is read from it.
  githubAppPrivateKeyFile?: string;
}

export const ROTATE_USAGE = `Usage: envctl secrets rotate [firebase|sentry|posthog|github-app] [OPTIONS]

Atomically rotate provider secrets: mint the new credential, redeploy, verify
it, then invalidate the old one — so the project is never left without a working
credential. Rotates Firebase service-account keys (per environment) and the
Sentry auth token (once, project-wide), for whichever are present in the Vercel
project. Auth for every provider to be rotated is checked up front, so an
unauthenticated provider fails fast instead of leaving a partial rotation.

ARGUMENTS:
  firebase | sentry | posthog | github-app
                           Restrict the rotation to a single provider
                           (default: every provider present in the project).
                           PostHog's personal API key is rotated by hand —
                           naming it prints the manual steps. github-app
                           rotates the webhook secret; its private key is
                           rotated by hand (the steps are printed)

OPTIONS:
  --env <name>             Environment to rotate (a name from environments.yml,
                           'development', or 'all') (default: all)
  --deployment-dir <path>  Path to the deployment config directory, resolved
                           against the project root (default: deployment)
  --no-invalidate          Keep the old keys after the redeploy
  --refresh-previews       Redeploy active PR previews after rotation
  --private-key-file <path>
                           GitHub App private key PEM, used to sign the App
                           JWT (required when github-app is rotated)
  -h, --help               Show this help`;

export const INIT_USAGE = `Usage: envctl secrets init [firebase|sentry|posthog|github-app] [OPTIONS]

Bootstrap provider secrets for a fresh project (implies a rotation). Omit the
service to auto-detect which to initialize from the deployment config. Fails if
the target secrets already exist in the Vercel project.

ARGUMENTS:
  firebase | sentry | posthog | github-app
                           Service to initialize (default: auto-detect).
                           PostHog is manual-only — naming it prints the steps

OPTIONS:
  --env <name>             Environment to initialize (default: all)
  --deployment-dir <path>  Path to the deployment config directory, resolved
                           against the project root (default: deployment)
  --no-invalidate          Keep the old keys after the redeploy
  --refresh-previews       Redeploy active PR previews after initialization
  --private-key-file <path>
                           GitHub App private key PEM to push and sign the App
                           JWT with (required for github-app)
  -h, --help               Show this help`;

// Parses `secrets rotate` / `secrets init` args (the global -C/--working-dir
// flag is already stripped by the router). `isInit` selects init mode: it seeds
// `init` to "auto" and accepts a leading firebase|sentry|posthog positional. Prints
// usage and exits 0 on -h/--help.
export function parseSecretsArgs(
  args: string[],
  workingDir: string,
  isInit: boolean,
): SecretsOptions {
  let targetEnv = "all";
  let deploymentDir = "deployment";
  let invalidateKeys = true;
  let refreshPreviews = false;
  let init: SecretsOptions["init"] = isInit ? "auto" : undefined;
  let provider: SecretsOptions["provider"];
  let providerTargetSet = false;
  let githubAppPrivateKeyFile: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--env") {
      targetEnv =
        args[++i] ?? err('--env requires an environment name or "all"');
      if (!targetEnv) err('--env requires an environment name or "all"');
    } else if (arg === "--deployment-dir") {
      deploymentDir = args[++i] ?? err("--deployment-dir requires a path");
      if (!deploymentDir) err("--deployment-dir requires a path");
    } else if (arg === "--private-key-file") {
      githubAppPrivateKeyFile =
        args[++i] ?? err("--private-key-file requires a path");
      if (!githubAppPrivateKeyFile) err("--private-key-file requires a path");
    } else if (arg === "--no-invalidate") {
      invalidateKeys = false;
    } else if (arg === "--refresh-previews") {
      refreshPreviews = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(isInit ? INIT_USAGE : ROTATE_USAGE);
      process.exit(0);
    } else if (
      !providerTargetSet &&
      (arg === "firebase" ||
        arg === "sentry" ||
        arg === "posthog" ||
        arg === "github-app")
    ) {
      // A leading firebase|sentry|posthog positional selects the init target in init
      // mode, or scopes the rotation to that provider in rotate mode.
      if (isInit) init = arg;
      else provider = arg;
      providerTargetSet = true;
    } else {
      const cmd = isInit ? "secrets init" : "secrets rotate";
      err(`Unknown option: ${arg}. Run 'envctl ${cmd} --help' for usage.`);
    }
  }

  return {
    targetEnv,
    workingDir,
    deploymentDir: path.resolve(workingDir, deploymentDir),
    invalidateKeys,
    refreshPreviews,
    init,
    provider,
    // A file the user names resolves against the shell's cwd, not -C.
    ...(githubAppPrivateKeyFile
      ? { githubAppPrivateKeyFile: path.resolve(githubAppPrivateKeyFile) }
      : {}),
  };
}
