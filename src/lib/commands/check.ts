import { checkStatic, type Finding } from "../check";
import { checkLive } from "../check-live";
import type { CommandContext } from "../cli/registry";
import { err, log } from "../logger";

const USAGE = `Usage: envctl check [--live]

Validate that the project's deployment config is coherent and deployable,
without changing anything. Reports every problem it finds and exits non-zero if
any is an error.

  --live   Also reconcile declared public variables against what is live on the
           deployment provider (requires network + auth).`;

function parseCheckArgs(args: string[]): { live: boolean } {
  let live = false;
  for (const arg of args) {
    if (arg === "--live") live = true;
    else if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else err(`Unknown option: ${arg}. Run 'envctl check --help' for usage.`);
  }
  return { live };
}

// `envctl check [--live]` — read-only validation of the project's deployment
// config. Prints each finding, then exits non-zero (via err) if any error was
// found.
export async function runCheck(
  ctx: CommandContext,
  args: string[],
): Promise<void> {
  const { live } = parseCheckArgs(args);

  const findings: Finding[] = checkStatic(ctx.workingDir);
  if (live) findings.push(...(await checkLive(ctx.workingDir)));

  for (const f of findings)
    console.error(`  ${f.severity === "error" ? "✖" : "⚠"} ${f.message}`);

  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warningCount = findings.length - errorCount;
  if (errorCount > 0)
    err(
      `check failed: ${errorCount} error(s)${warningCount ? `, ${warningCount} warning(s)` : ""}.`,
    );
  log(
    warningCount > 0
      ? `OK with ${warningCount} warning(s).`
      : "OK — deployment config is valid.",
  );
}
