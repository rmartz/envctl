import * as fs from "fs";
import * as path from "path";

import type { CommandContext } from "../cli/registry";
import { vercelTarget } from "../environments";
import { err, log } from "../logger";
import { commandExists, run } from "../subprocess";

interface PullOptions {
  // Deployment environment name (mapped to a Vercel target via vercelTarget).
  env: string;
  // Absolute path to the dotenv file to write.
  out: string;
  // Absolute project root the pull runs in (from -C/--working-dir or CWD).
  workingDir: string;
}

export const PULL_USAGE = `Usage: envctl env pull [OPTIONS]

Materialize a local dotenv file from a Vercel environment for local
development. Delegates to the Vercel CLI (\`vercel env pull\`), which handles
decryption and dotenv escaping. The environment name is mapped to its Vercel
target the same way as 'config push' (development -> development, staging ->
preview, ...).

OPTIONS:
  --env <name>   Environment to pull (default: development)
  --out <path>   Output file, resolved against the project root
                 (default: .env.local)
  -h, --help     Show this help`;

// `args` has already had the global -C/--working-dir flag stripped by the router.
export function parsePullArgs(args: string[], workingDir: string): PullOptions {
  let env = "development";
  let out = ".env.local";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--env") {
      env = args[++i] ?? err("--env requires an environment name");
    } else if (arg === "--out") {
      out = args[++i] ?? err("--out requires a path");
    } else if (arg === "-h" || arg === "--help") {
      console.log(PULL_USAGE);
      process.exit(0);
    } else {
      err(`Unknown option: ${arg}. Run 'envctl env pull --help' for usage.`);
    }
  }

  return { env, out: path.resolve(workingDir, out), workingDir };
}

// `envctl env pull` — pull a Vercel environment's variables into a local dotenv
// file. Wraps the Vercel CLI (it owns decryption + escaping); preflights that
// the CLI is present and the directory is a linked Vercel project so the CLI
// never drops into an interactive prompt.
export function runEnvPull(ctx: CommandContext, args: string[]): void {
  const opts = parsePullArgs(args, ctx.workingDir);

  if (!commandExists("vercel")) {
    err(
      "The Vercel CLI is required for 'env pull'. Install it (e.g. `npm i -g vercel`) and run `vercel login`.",
    );
  }
  if (!fs.existsSync(path.join(ctx.workingDir, ".vercel", "project.json"))) {
    err(
      "Not a linked Vercel project (no .vercel/project.json). Run `vercel link` first.",
    );
  }

  const target = vercelTarget(opts.env);
  log(`Pulling '${opts.env}' (${target}) into ${opts.out}...`);
  try {
    run("vercel", ["env", "pull", opts.out, `--environment=${target}`], {
      cwd: ctx.workingDir,
    });
  } catch (error) {
    err(
      `vercel env pull failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  log(`Wrote ${opts.out}`);
}
