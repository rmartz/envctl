#!/usr/bin/env node
/**
 * Agent directive-file check — enforces the AGENTS.md convention (see AGENTS.md):
 *
 *   1. All directives live in AGENTS.md (the single source of truth).
 *   2. Every AGENTS.md has a companion CLAUDE.md in the same directory, and
 *      every CLAUDE.md has a companion AGENTS.md in the same directory.
 *   3. Every CLAUDE.md is a bare wrapper whose only content is the Claude Code
 *      import line `@AGENTS.md` — no directives, no other text, no symlinks.
 *
 * Walks the working tree (skipping vendored / build / VCS directories), pairs
 * AGENTS.md and CLAUDE.md files by directory, and reports every violation.
 *
 * Exits 0 when the whole tree is compliant, 1 when any violation is found.
 *
 * Usage: node scripts/check-agents-md.mjs
 */
import { readdirSync, readFileSync, lstatSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Directories that never contain first-party directive files.
const SKIP_DIRS = new Set([
  ".git",
  ".git-worktrees",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

// The exact content a CLAUDE.md wrapper must import.
const IMPORT_LINE = "@AGENTS.md";

// Recursively collect every directory that contains an AGENTS.md or CLAUDE.md.
function collectDirs(dir, found) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectDirs(join(dir, entry.name), found);
    } else if (entry.name === "AGENTS.md" || entry.name === "CLAUDE.md") {
      found.add(dir);
    }
  }
  return found;
}

function existsInDir(dir, name) {
  try {
    lstatSync(join(dir, name));
    return true;
  } catch {
    return false;
  }
}

// Validate a CLAUDE.md wrapper. Returns an error string, or undefined when the
// file is a compliant bare `@AGENTS.md` wrapper. A symlink is rejected outright
// — the convention requires a real file containing the import line.
function wrapperError(claudePath) {
  const stat = lstatSync(claudePath);
  if (stat.isSymbolicLink()) {
    return "CLAUDE.md is a symlink; it must be a real file containing only `@AGENTS.md`";
  }
  if (!stat.isFile()) {
    return "CLAUDE.md is not a regular file; it must be a real file containing only `@AGENTS.md`";
  }
  const meaningfulLines = readFileSync(claudePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (meaningfulLines.length === 1 && meaningfulLines[0] === IMPORT_LINE) {
    return undefined;
  }
  return `CLAUDE.md must contain only the bare import line \`${IMPORT_LINE}\`, but found: ${JSON.stringify(meaningfulLines)}`;
}

function main() {
  const violations = [];
  for (const dir of collectDirs(root, new Set())) {
    const rel = relative(root, dir) || ".";
    const hasAgents = existsInDir(dir, "AGENTS.md");
    const hasClaude = existsInDir(dir, "CLAUDE.md");

    if (hasAgents && !hasClaude) {
      violations.push(`${rel}: AGENTS.md has no companion CLAUDE.md`);
    }
    if (hasClaude && !hasAgents) {
      violations.push(`${rel}: CLAUDE.md has no companion AGENTS.md`);
    }
    if (hasClaude) {
      const error = wrapperError(join(dir, "CLAUDE.md"));
      if (error) violations.push(`${rel}: ${error}`);
    }
  }

  if (violations.length > 0) {
    console.error("Agent directive-file convention violations:\n");
    for (const violation of violations) console.error(`  ✗ ${violation}`);
    console.error(
      `\n${violations.length} violation(s). Every directory must satisfy all three rules:\n` +
        `  1. Every AGENTS.md has a companion CLAUDE.md in the same directory.\n` +
        `  2. Every CLAUDE.md has a companion AGENTS.md in the same directory.\n` +
        `  3. Every CLAUDE.md is a real file (not a symlink) whose only content is \`${IMPORT_LINE}\`.\n` +
        `See AGENTS.md for the full convention.`,
    );
    process.exit(1);
  }

  console.log("Agent directive-file check: ok");
}

main();
