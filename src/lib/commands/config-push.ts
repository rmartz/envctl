import * as fs from "fs";
import * as path from "path";

import { resolveVercelToken } from "../auth";
import type { CommandContext } from "../cli/registry";
import {
  listActiveEnvs,
  parseDeploymentEnv,
  vercelTarget,
} from "../environments";
import { err, log, warn } from "../logger";
import { detectProject } from "../project";
import { VercelClient } from "../vercel-api";
import { parsePushArgs, type PushOptions } from "./config-push-args";

export type { PushOptions };

// Returns the first active env whose Vercel target is "preview" (i.e. staging).
// The development target always mirrors this source for its public vars.
function findDevSource(activeEnvs: string[]): string | undefined {
  return activeEnvs.find((e) => vercelTarget(e) === "preview");
}

function checkPrereqs(
  opts: PushOptions,
  token: string | undefined,
): asserts token is string {
  if (!token)
    err(
      "No Vercel token found. Set VERCEL_TOKEN or run 'vercel login' to authenticate.",
    );
  if (!fs.existsSync(opts.deploymentDir))
    err(`Deployment directory not found: ${opts.deploymentDir}`);
  const envsFile = path.join(opts.deploymentDir, "environments.yml");
  if (!fs.existsSync(envsFile)) err(`environments.yml not found: ${envsFile}`);
}

// Resolves which active environments to push and whether the implicit
// development target should be synced, validating the requested --env.
function resolvePlan(
  opts: PushOptions,
  activeEnvs: string[],
  devSource: string | undefined,
): { envList: string[]; syncDev: boolean } {
  let envList: string[];
  if (opts.targetEnv === "all") {
    envList = activeEnvs;
  } else if (opts.targetEnv === "development") {
    if (!devSource)
      err(
        "--env development requires a staging or preview environment in environments.yml",
      );
    envList = [];
  } else {
    if (!activeEnvs.includes(opts.targetEnv)) {
      err(
        `--env '${opts.targetEnv}' not in active environments: ${activeEnvs.join(", ")}`,
      );
    }
    envList = [opts.targetEnv];
  }

  const syncDev =
    (opts.targetEnv === "all" || opts.targetEnv === "development") &&
    devSource !== undefined;

  return { envList, syncDev };
}

function dryRunPlan(
  opts: PushOptions,
  envList: string[],
  syncDev: boolean,
  devSource: string | undefined,
): void {
  log("Dry run — no changes will be made");
  for (const envName of envList) {
    const envFile = path.join(opts.deploymentDir, `${envName}.yml`);
    if (!fs.existsSync(envFile)) {
      warn(`No config file for '${envName}': ${envFile}`);
      continue;
    }
    log(`Would push ${envName} → ${vercelTarget(envName)}:`);
    const vars = parseDeploymentEnv(opts.deploymentDir, envName);
    for (const key of Object.keys(vars)) log(`  Would push: ${key}`);
  }
  if (syncDev && devSource) {
    log(`Would push development (from ${devSource}) → development:`);
    const vars = parseDeploymentEnv(opts.deploymentDir, devSource);
    for (const key of Object.keys(vars)) log(`  Would push: ${key}`);
  }
}

// Upserts every variable in `vars` for the given Vercel target, re-listing the
// remote env vars first so writes from a prior environment are reflected.
// Returns the running totals incremented by this pass.
async function pushVars(
  client: VercelClient,
  label: string,
  target: string,
  vars: Record<string, string>,
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  const allEnvs = await client.listEnvVars();
  for (const key of Object.keys(vars)) {
    const existing = client.findEnvVar(allEnvs.envs, key, target);
    if (existing) {
      await client.updateEnvVar(existing.id, vars[key]);
      log(`  Updated : ${key}`);
      updated++;
    } else {
      await client.createEnvVar(key, vars[key], target, "plain");
      log(`  Created : ${key}`);
      created++;
    }
  }
  log(`  ${label} — ${created} created, ${updated} updated`);
  return { created, updated };
}

// Pushes public env vars for a single named environment, skipping (with a
// warning) when its YAML file is missing or empty.
async function pushEnv(
  client: VercelClient,
  opts: PushOptions,
  envName: string,
): Promise<{ created: number; updated: number }> {
  const envFile = path.join(opts.deploymentDir, `${envName}.yml`);
  if (!fs.existsSync(envFile)) {
    warn(`No config file for '${envName}': ${envFile} — skipping`);
    return { created: 0, updated: 0 };
  }
  const target = vercelTarget(envName);
  log(`Pushing ${envName} → ${target}...`);
  const vars = parseDeploymentEnv(opts.deploymentDir, envName);
  if (Object.keys(vars).length === 0) {
    warn(`No variables found in ${envFile} — skipping`);
    return { created: 0, updated: 0 };
  }
  return pushVars(client, envName, target, vars);
}

// Pushes the staging/preview YAML to the implicit development target.
async function pushDev(
  client: VercelClient,
  opts: PushOptions,
  devSource: string,
): Promise<{ created: number; updated: number }> {
  const devEnvFile = path.join(opts.deploymentDir, `${devSource}.yml`);
  if (!fs.existsSync(devEnvFile)) {
    warn(
      `No config file for development source '${devSource}': ${devEnvFile} — skipping development push`,
    );
    return { created: 0, updated: 0 };
  }
  const vars = parseDeploymentEnv(opts.deploymentDir, devSource);
  if (Object.keys(vars).length === 0) {
    warn(`No variables found in ${devEnvFile} — skipping development push`);
    return { created: 0, updated: 0 };
  }
  log(`Pushing development (from ${devSource}) → development...`);
  return pushVars(
    client,
    `development (from ${devSource})`,
    "development",
    vars,
  );
}

// Orchestrates the public-variable push. Accepts fully-resolved options so it
// is directly unit-testable (mirroring the predecessor's `sync-env` run()).
export async function runPush(opts: PushOptions): Promise<void> {
  const token = resolveVercelToken();
  checkPrereqs(opts, token);

  const project = detectProject(opts.workingDir);
  log(
    `Project: ${project.projectId}${project.teamId ? ` (team: ${project.teamId})` : ""}`,
  );

  const activeEnvs = listActiveEnvs(opts.deploymentDir);
  if (activeEnvs.length === 0)
    err(
      `No active environments found in ${opts.deploymentDir}/environments.yml`,
    );

  const devSource = findDevSource(activeEnvs);
  const { envList, syncDev } = resolvePlan(opts, activeEnvs, devSource);

  if (opts.dryRun) {
    dryRunPlan(opts, envList, syncDev, devSource);
    return;
  }

  const client = new VercelClient(token, project.projectId, project.teamId);
  let totalCreated = 0;
  let totalUpdated = 0;

  for (const envName of envList) {
    const { created, updated } = await pushEnv(client, opts, envName);
    totalCreated += created;
    totalUpdated += updated;
  }

  if (syncDev && devSource) {
    const { created, updated } = await pushDev(client, opts, devSource);
    totalCreated += created;
    totalUpdated += updated;
  }

  log(
    `Done — ${totalCreated} created, ${totalUpdated} updated across all target environments.`,
  );
}

// Command adapter: parses args (with the global -C already stripped by the
// router) and dispatches to runPush, resolving deployment-dir against the
// project root from ctx.workingDir.
export async function configPushCommand(
  ctx: CommandContext,
  args: string[],
): Promise<void> {
  await runPush(parsePushArgs(args, ctx.workingDir));
}
