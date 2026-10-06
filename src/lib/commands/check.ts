import { checkStatic, type Finding } from "../check";
import { checkLive } from "../check-live";
import type { CommandContext } from "../cli/registry";
import { err, log } from "../logger";

const USAGE = `Usage: envctl check [--live] [--json]

Validate that the project's deployment config is coherent and deployable,
without changing anything. Reports every problem it finds and exits non-zero if
any is an error.

  --live   Also reconcile the declared variables against what is live on the
           deployment provider — missing, orphaned, and cross-environment
           collisions (requires network + auth).
  --json   Print the findings as a JSON array on stdout instead of the human
           report; still exits non-zero when any finding is an error.`;

function parseCheckArgs(args: string[]): { live: boolean; json: boolean } {
  let live = false;
  let json = false;
  for (const arg of args) {
    if (arg === "--live") live = true;
    else if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else err(`Unknown option: ${arg}. Run 'envctl check --help' for usage.`);
  }
  return { live, json };
}

// The machine-readable shape of a finding: `kind` names the rule ("general"
// for findings that carry no structured context).
const toJson = (f: Finding) => ({
  severity: f.severity,
  kind: f.kind ?? "general",
  ...(f.env !== undefined && { env: f.env }),
  ...(f.target !== undefined && { target: f.target }),
  ...(f.key !== undefined && { key: f.key }),
  message: f.message,
});

// `envctl check [--live] [--json]` — read-only validation of the project's
// deployment config. Prints each finding (or the JSON array), then exits
// non-zero (via err) if any error was found.
export async function runCheck(
  ctx: CommandContext,
  args: string[],
): Promise<void> {
  const { live, json } = parseCheckArgs(args);

  const findings: Finding[] = checkStatic(ctx.workingDir);
  if (live) findings.push(...(await checkLive(ctx.workingDir)));

  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warningCount = findings.length - errorCount;

  if (json) {
    console.log(JSON.stringify(findings.map(toJson), null, 2));
    if (errorCount > 0) err(`check failed: ${errorCount} error(s).`);
    return;
  }

  for (const f of findings)
    console.error(`  ${f.severity === "error" ? "✖" : "⚠"} ${f.message}`);

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
