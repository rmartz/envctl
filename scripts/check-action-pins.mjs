#!/usr/bin/env node
/**
 * Action-pin check — enforces that every third-party GitHub Actions `uses:`
 * reference is pinned to a full commit SHA (not a movable tag) AND carries a
 * semver version comment (e.g. `# v1.2.3`). The SHA pin defeats a moved-tag
 * supply-chain attack; the comment lets Dependabot keep the SHA up to date.
 *
 * Local (`./…`), parent (`../…`), and `docker://` references are exempt — a
 * local composite action lives in-repo, and docker refs aren't tag-pinnable
 * this way.
 *
 * Usage: node scripts/check-action-pins.mjs
 */
import * as fs from "node:fs";
import * as path from "node:path";

const SCAN_DIRS = [".github/workflows", ".github/actions"];
const USES = /^\s*(?:-\s*)?uses:\s*(\S+)(?:\s+#\s*(.*\S))?\s*$/;
const SHA = /^[0-9a-f]{40}$/;
const VERSION_COMMENT = /\bv?\d+(?:\.\d+){0,2}\b/;

function yamlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) return yamlFiles(p);
    return /\.ya?ml$/.test(entry.name) ? [p] : [];
  });
}

function checkFile(file) {
  const violations = [];
  fs.readFileSync(file, "utf-8")
    .split("\n")
    .forEach((line, i) => {
      const match = USES.exec(line);
      if (!match) return;
      const [, ref, comment] = match;
      if (/^(\.{1,2}\/|docker:\/\/)/.test(ref)) return; // local / docker — exempt
      const where = `${file}:${i + 1}`;
      const at = ref.lastIndexOf("@");
      if (at === -1) {
        violations.push(`${where}: '${ref}' has no @ref — pin to a commit SHA`);
      } else if (!SHA.test(ref.slice(at + 1))) {
        violations.push(
          `${where}: '${ref}' is not SHA-pinned — pin to a full commit SHA`,
        );
      } else if (!comment || !VERSION_COMMENT.test(comment)) {
        violations.push(
          `${where}: '${ref}' lacks a version comment (e.g. '# v1.2.3') for Dependabot`,
        );
      }
    });
  return violations;
}

function main() {
  const violations = SCAN_DIRS.flatMap(yamlFiles).flatMap(checkFile);
  if (violations.length > 0) {
    console.error(
      "Action-pin check failed — every third-party action must be pinned to a " +
        "commit SHA with a version comment:",
    );
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
  console.log("Action-pin check: ok");
}

main();
