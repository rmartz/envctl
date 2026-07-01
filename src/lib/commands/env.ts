import * as fs from "fs";

import type { CommandContext } from "../cli/registry";
import { listActiveEnvs, vercelTarget } from "../environments";
import { err, log, warn } from "../logger";
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
create deployment/<name>.yml. The provider target follows the name convention
(see 'envctl env list'); --target declares the intended mapping and is validated
against the allowed set.`;

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

  const active = listActiveEnvs(deploymentDir(ctx.workingDir));
  if (active.includes(name)) {
    warn(`'${name}' is already an active environment — config unchanged.`);
    return;
  }

  const conventional = vercelTarget(name);
  if (conventional !== target) {
    warn(
      `'${name}' maps to target '${conventional}' by name convention; ` +
        `recorded --target '${target}' (config push maps by name).`,
    );
  }

  writeActiveEnvs(ctx.workingDir, [...active, name]);
  if (!fs.existsSync(envFile(ctx.workingDir, name))) {
    writeEnvFile(ctx.workingDir, name, {});
  }

  log(
    `Added '${name}'. Edit ${envFile(ctx.workingDir, name)} to set its vars.`,
  );
}

// `envctl env list` — list defined environments and their provider targets.
export function runEnvList(ctx: CommandContext): void {
  requireConfig(ctx);

  const active = listActiveEnvs(deploymentDir(ctx.workingDir));
  if (active.length === 0) {
    log("No environments defined.");
    return;
  }

  log("Environments:");
  for (const name of active) {
    log(`  ${name} → ${vercelTarget(name)}`);
  }
}
