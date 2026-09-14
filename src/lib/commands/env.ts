import * as fs from "fs";

import type { CommandContext } from "../cli/registry";
import { listActiveEnvs } from "../environments";
import { setManifestTarget } from "../manifest";
import { err, log, warn } from "../logger";
import { envTargetResolver } from "../targets";
import {
  deploymentDir,
  environmentsFile,
  envFile,
  isValidTarget,
  VALID_TARGETS,
  writeActiveEnvs,
  writeEnvFile,
  type DeployTarget,
} from "./deployment-config";

const ENV_ADD_USAGE = `Usage: envctl env add <name> --target <${VALID_TARGETS.join("|")}>

Define an environment: append <name> to environments.yml's active list and
create deployment/<name>.yml. --target is required and sets the authoritative
Vercel deployment target for this env (written to manifest.yml), used by config
push, env pull, and secrets rotation.`;

interface AddArgs {
  name: string;
  target: DeployTarget;
}

function parseAddArgs(args: string[]): AddArgs {
  let name: string | undefined;
  let target: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--target") {
      target = args[++i] ?? err("--target requires a value");
    } else if (arg === "-h" || arg === "--help") {
      console.log(ENV_ADD_USAGE);
      process.exit(0);
    } else if (arg.startsWith("-")) {
      err(`Unknown option: ${arg}. Run 'envctl env add --help' for usage.`);
    } else if (name === undefined) {
      name = arg;
    } else {
      err(`Unexpected argument: ${arg}`);
    }
  }

  if (name === undefined) return err("env add requires an environment name");
  if (name.includes("/") || name.includes(".."))
    return err(
      `Invalid environment name '${name}': must not contain '/' or '..'`,
    );
  if (target === undefined)
    return err(`env add requires --target <${VALID_TARGETS.join("|")}>`);
  if (!isValidTarget(target))
    return err(
      `Invalid --target '${target}'. Must be one of: ${VALID_TARGETS.join(", ")}`,
    );

  return { name, target };
}

function requireConfig(ctx: CommandContext): void {
  if (!fs.existsSync(environmentsFile(ctx.workingDir)))
    err("No deployment config found. Run 'envctl init' first.");
}

// `envctl env add <name> --target <t>` — append the environment to the active
// list and scaffold its file. Idempotent: an already-active name is a no-op.
export function runEnvAdd(ctx: CommandContext, args: string[]): void {
  const { name, target } = parseAddArgs(args);
  requireConfig(ctx);

  const dir = deploymentDir(ctx.workingDir);
  const active = listActiveEnvs(dir);
  if (active.includes(name)) {
    warn(`'${name}' is already an active environment — config unchanged.`);
    return;
  }

  writeActiveEnvs(ctx.workingDir, [...active, name]);
  if (!fs.existsSync(envFile(ctx.workingDir, name))) {
    writeEnvFile(ctx.workingDir, name, {});
  }
  // Persist the explicit env→target mapping into the manifest (#87), where it is
  // now authoritative for config push / secrets — rather than validated and
  // dropped as before.
  setManifestTarget(dir, name, target);

  log(
    `Added '${name}' → ${target}. Edit ${envFile(ctx.workingDir, name)} to set its vars.`,
  );
}

// `envctl env list` — list defined environments and their provider targets.
export function runEnvList(ctx: CommandContext): void {
  requireConfig(ctx);

  const dir = deploymentDir(ctx.workingDir);
  const active = listActiveEnvs(dir);
  if (active.length === 0) {
    log("No environments defined.");
    return;
  }

  const resolveTarget = envTargetResolver(dir);
  log("Environments:");
  for (const name of active) {
    log(`  ${name} → ${resolveTarget(name)}`);
  }
}
