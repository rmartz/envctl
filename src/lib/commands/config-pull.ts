import * as fs from "fs";
import * as path from "path";

import type { CommandContext } from "../cli/registry";
import { vercelTarget } from "../environments";
import { err, log, warn } from "../logger";
import { commandExists, run, runStatus } from "../subprocess";

interface PullOptions {
  // Deployment environment name (mapped to a Vercel target via vercelTarget).
  env: string;
  // Absolute path to the dotenv file to write.
  out: string;
  // Overwrite an existing target file. Without it, an existing file is refused.
  force: boolean;
}

export const PULL_USAGE = `Usage: envctl config pull [OPTIONS]

Materialize a local dotenv file from an environment for local development — the
inverse of 'config push'. Delegates to the Vercel CLI (\`vercel env pull\`),
which handles decryption and dotenv escaping, so the pulled file includes the
environment's secrets. The environment name is mapped to its Vercel target the
same way as 'config push' (development -> development, staging -> preview, ...).

The target holds live secrets: it is written with owner-only (0600) permissions
and 'config pull' warns if it is not gitignored.

OPTIONS:
  --env <name>   Environment to pull (default: development)
  --out <path>   Output file, resolved against the project root
                 (default: .env.local)
  --force        Overwrite the target file if it already exists
  -h, --help     Show this help`;

// `args` has already had the global -C/--working-dir flag stripped by the router.
export function parsePullArgs(args: string[], workingDir: string): PullOptions {
  let env = "development";
  let out = ".env.local";
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--env") {
      env = args[++i] ?? err("--env requires an environment name");
    } else if (arg === "--out") {
      out = args[++i] ?? err("--out requires a path");
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(PULL_USAGE);
      process.exit(0);
    } else {
      err(`Unknown option: ${arg}. Run 'envctl config pull --help' for usage.`);
    }
  }

  return { env, out: path.resolve(workingDir, out), force };
}

// Warns when the pulled file is not gitignored, since it now holds live
// secrets. Uses `git check-ignore` (the authoritative source: it honors nested
// .gitignore, negations, and global excludes) rather than reimplementing the
// match. Silently skips when git is absent or the path is outside a repo — a
// spurious warning is worse than none for an advisory check.
function warnIfNotGitIgnored(target: string, cwd: string): void {
  if (!commandExists("git")) return;
  const { status } = runStatus("git", ["check-ignore", "-q", "--", target], {
    cwd,
  });
  if (status === 1)
    warn(
      `${target} is not gitignored — it holds secrets and may be committed. Add it to .gitignore.`,
    );
}

// `envctl config pull` — pull an environment's variables into a local dotenv
// file, the inverse of `config push`. Wraps the Vercel CLI (it owns decryption
// + escaping); preflights that the CLI is present and the directory is a linked
// Vercel project, refuses to clobber an existing file without --force, and
// restricts the written file to the owner because it contains secrets.
export function runConfigPull(ctx: CommandContext, args: string[]): void {
  const opts = parsePullArgs(args, ctx.workingDir);

  if (!commandExists("vercel")) {
    err(
      "The Vercel CLI is required for 'config pull'. Install it (e.g. `npm i -g vercel`) and run `vercel login`.",
    );
  }
  if (!fs.existsSync(path.join(ctx.workingDir, ".vercel", "project.json"))) {
    err(
      "Not a linked Vercel project (no .vercel/project.json). Run `vercel link` first.",
    );
  }
  // Use lstatSync (not existsSync) to avoid following symlinks: a dangling
  // symlink returns false from existsSync but lstatSync detects it.
  let targetStat: fs.Stats | undefined;
  try {
    targetStat = fs.lstatSync(opts.out);
  } catch {
    // Target does not exist — safe to create.
  }
  if (targetStat !== undefined) {
    if (!targetStat.isFile()) {
      err(
        `${opts.out} exists but is not a regular file — refusing to write secrets to it.`,
      );
    }
    if (!opts.force) {
      err(`Refusing to overwrite ${opts.out} without --force.`);
    }
  }

  const target = vercelTarget(opts.env);
  // Pre-create the target at 0600 before the CLI writes secrets into it,
  // closing the window where the CLI creates the file with a permissive umask.
  // chmodSync handles existing files, since writeFileSync's mode applies only
  // on creation.
  fs.writeFileSync(opts.out, "", { mode: 0o600 });
  fs.chmodSync(opts.out, 0o600);
  log(`Pulling '${opts.env}' (${target}) into ${opts.out}...`);
  try {
    run(
      "vercel",
      ["env", "pull", opts.out, `--environment=${target}`, "--yes"],
      {
        cwd: ctx.workingDir,
        env: { ...process.env, VERCEL_NON_INTERACTIVE: "1" },
      },
    );
  } catch (error) {
    err(
      `vercel env pull failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Backstop: some CLIs replace the inode (temp-then-rename); re-lock after write.
  fs.chmodSync(opts.out, 0o600);
  warnIfNotGitIgnored(opts.out, ctx.workingDir);
  log(`Wrote ${opts.out}`);
}

// Deprecated alias: `envctl env pull` now lives at `config pull` (the inverse of
// `config push`). Warns, then delegates so existing scripts keep working.
export function runEnvPullDeprecated(
  ctx: CommandContext,
  args: string[],
): void {
  warn("'envctl env pull' is deprecated — use 'envctl config pull' instead.");
  runConfigPull(ctx, args);
}
