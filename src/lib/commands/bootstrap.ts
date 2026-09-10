import { resolveSentryToken, resolveVercelToken } from "../auth";
import type { CommandContext } from "../cli/registry";
import { triggerAndWaitRedeployments } from "../deployments";
import { listActiveEnvs } from "../environments";
import { err, log } from "../logger";
import { detectProject } from "../project";
import { commandExists } from "../subprocess";
import { VercelClient } from "../vercel-api";
import { parseBootstrapArgs } from "./bootstrap-args";
import type { BootstrapOptions } from "./bootstrap-args";
import { runPush } from "./config-push";
import { runEnvPull } from "./env-pull";
import {
  assertDeploymentPrereqs,
  findDevSource,
  resolveEnvList,
} from "./env-plan";
import { runSecrets } from "./secrets";
import { detectConfiguredServices } from "./secrets-plan";

type Configured = { firebase: boolean; sentry: boolean };

// Fails fast, before any change, on the prerequisites the three phases need:
// a resolvable Vercel project, the Vercel CLI (for the pull), gcloud (for
// Firebase), and a Sentry token (for Sentry). Tool-existence checks are skipped
// on --dry-run because those tools are never invoked on that path.
function bootstrapPreflight(
  opts: BootstrapOptions,
  configured: Configured,
): void {
  detectProject(opts.workingDir); // throws early if the project can't be resolved
  if (opts.dryRun) return;
  if (opts.pull && !commandExists("vercel"))
    err(
      "The Vercel CLI is required for the local pull phase. Install it (e.g. `npm i -g vercel`) or pass --no-pull.",
    );
  if (configured.firebase && !commandExists("gcloud"))
    err(
      "gcloud is required to initialize Firebase secrets. Authenticate gcloud, or remove Firebase config to skip it.",
    );
  if (configured.sentry && !resolveSentryToken())
    err(
      "A Sentry token is required to initialize Sentry secrets. Set SENTRY_AUTH_TOKEN or run `sentry-cli login`.",
    );
}

// The three fixed Vercel deployment targets. Used to check full presence for
// "--env all": a secret is "already present" only if it covers all targets.
const ALL_VERCEL_TARGETS = ["production", "preview", "development"] as const;

// Reports which providers already have their secret present in the Vercel
// project, scoped to the requested target(s) so a partial prior run (e.g. key
// exists for production only) does not incorrectly skip other environments.
async function detectExistingSecrets(
  client: VercelClient,
  targetEnv: string,
): Promise<Configured> {
  const { envs } = await client.listEnvVars();
  const isPresent = (key: string): boolean => {
    if (targetEnv === "all") {
      return ALL_VERCEL_TARGETS.every((t) =>
        envs.some((e) => e.key === key && e.target.includes(t)),
      );
    }
    return envs.some((e) => e.key === key && e.target.includes(targetEnv));
  };
  return {
    firebase: ["FIREBASE_SERVICE_ACCOUNT", "FIREBASE_PRIVATE_KEY"].some(
      isPresent,
    ),
    sentry: ["SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN"].some(isPresent),
  };
}

// Phase 2: initialize each configured secret that is not already present.
// Idempotent — an existing secret is left in place (rotate it explicitly).
async function bootstrapSecrets(
  opts: BootstrapOptions,
  token: string,
  configured: Configured,
): Promise<void> {
  const services = (["firebase", "sentry"] as const).filter(
    (s) => configured[s],
  );
  if (services.length === 0) {
    log("  No secret providers configured — skipping.");
    return;
  }

  if (opts.dryRun) {
    for (const s of services)
      log(`  Would initialize ${s} secrets if not already present.`);
    return;
  }

  const project = detectProject(opts.workingDir);
  const client = new VercelClient(token, project.projectId, project.teamId);
  const present = await detectExistingSecrets(client, opts.targetEnv);

  for (const service of services) {
    if (present[service]) {
      log(
        `  ${service}: already present — skipping (use 'envctl secrets rotate' to rotate).`,
      );
      continue;
    }
    log(`  ${service}: initializing...`);
    await runSecrets({
      targetEnv: opts.targetEnv,
      workingDir: opts.workingDir,
      deploymentDir: opts.deploymentDir,
      invalidateKeys: true,
      refreshPreviews: false,
      init: service,
    });
  }
}

// Phase 4: trigger redeployments so running environments pick up the pushed
// vars. On a zero-deployment project this logs a skip per env (the
// "No READY deployment found" message) rather than erroring, satisfying the
// #71 requirement that bootstrap explicitly reports when verification is skipped.
async function bootstrapVerify(
  opts: BootstrapOptions,
  token: string,
): Promise<void> {
  if (opts.dryRun) {
    log("  Would trigger redeployments to verify pushed configuration.");
    return;
  }
  const project = detectProject(opts.workingDir);
  const client = new VercelClient(token, project.projectId, project.teamId);
  await triggerAndWaitRedeployments(opts.targetEnv, client);
}

// Phase 3: materialize the local dotenv file from the development environment.
function bootstrapPull(opts: BootstrapOptions): void {
  if (!opts.pull) {
    log("  Skipping local dotenv pull (--no-pull).");
    return;
  }
  if (opts.dryRun) {
    log(`  Would pull development into ${opts.out}.`);
    return;
  }
  runEnvPull({ workingDir: opts.workingDir }, [
    "--env",
    "development",
    "--out",
    opts.out,
  ]);
}

// Orchestrates the end-to-end bootstrap: public config, then any missing
// secrets, then the local dotenv file. Accepts fully-resolved options so it is
// directly unit-testable.
export async function runBootstrap(opts: BootstrapOptions): Promise<void> {
  const token = resolveVercelToken();
  assertDeploymentPrereqs(opts.deploymentDir, token); // narrows token to string

  const activeEnvs = listActiveEnvs(opts.deploymentDir);
  if (activeEnvs.length === 0)
    err(
      `No active environments found in ${opts.deploymentDir}/environments.yml`,
    );
  const devSource = findDevSource(activeEnvs);
  const envList = resolveEnvList(activeEnvs, opts.targetEnv, devSource);
  const configured = detectConfiguredServices(
    opts.deploymentDir,
    opts.targetEnv,
    envList,
    devSource,
  );

  bootstrapPreflight(opts, configured);

  log(
    opts.dryRun
      ? "Bootstrap dry run — no changes will be made"
      : "Bootstrapping project...",
  );

  log("Phase 1/4 — public environment variables");
  await runPush({
    targetEnv: opts.targetEnv,
    workingDir: opts.workingDir,
    deploymentDir: opts.deploymentDir,
    dryRun: opts.dryRun,
  });

  log("Phase 2/4 — provider secrets");
  await bootstrapSecrets(opts, token, configured);

  log("Phase 3/4 — local environment file");
  bootstrapPull(opts);

  log("Phase 4/4 — post-push verification");
  await bootstrapVerify(opts, token);

  log(opts.dryRun ? "Dry run complete." : "Bootstrap complete.");
}

// Command adapter: parses args (the global -C is already stripped by the
// router) and dispatches to the orchestrator.
export async function runBootstrapCommand(
  ctx: CommandContext,
  args: string[],
): Promise<void> {
  await runBootstrap(parseBootstrapArgs(args, ctx.workingDir));
}
