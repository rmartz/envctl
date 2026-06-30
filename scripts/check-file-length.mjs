#!/usr/bin/env node
/**
 * File-length ratchet — the CI backstop behind ESLint's `max-lines`.
 *
 * Port of the dotfiles / ai-tools ratchet, as a node-native script so it needs
 * no extra runtime dependency. A changed `.ts` file fails only if it is over
 * the limit AND the change grows it (or leaves it unchanged) vs. the merge
 * base; reducing an oversized file always passes, because progress toward a
 * healthy codebase is never blocked. A file under the limit always passes; a
 * newly-added file over the limit always fails.
 *
 * Usage:
 *   node scripts/check-file-length.mjs --base <ref>   # CI: diff against merge-base
 *   node scripts/check-file-length.mjs --staged       # pre-commit hook
 */
import { execFileSync } from "node:child_process";

const SPLIT_THRESHOLD = 240;
const RATCHET = SPLIT_THRESHOLD * 2; // 480 — matches ESLint max-lines
const TEST_RATCHET = 720;

const limitFor = (path) =>
  /\.test\.ts$|\/__tests__\//.test(path) ? TEST_RATCHET : RATCHET;

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const lineCount = (text) => (text === "" ? 0 : text.split("\n").length);

function changedFiles(base, staged) {
  const args = staged
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR"]
    : ["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`];
  return git(...args)
    .split("\n")
    .filter((f) => f.endsWith(".ts"));
}

function lengthAt(ref, path) {
  try {
    return ref === null
      ? lineCount(git("show", `:${path}`)) // staged blob
      : lineCount(git("show", `${ref}:${path}`));
  } catch {
    return 0; // new file — no prior version
  }
}

function main() {
  const args = process.argv.slice(2);
  const staged = args.includes("--staged");
  const baseIdx = args.indexOf("--base");
  const base = baseIdx >= 0 ? args[baseIdx + 1] : staged ? null : "origin/main";

  // Nothing to diff against (e.g. the genesis commit, before origin/main exists).
  if (!staged && base !== null) {
    try {
      git("rev-parse", "--verify", `${base}^{commit}`);
    } catch {
      console.log(`File-length ratchet: base ${base} not found — skipping.`);
      return;
    }
  }

  const failures = [];
  for (const path of changedFiles(staged ? null : base, staged)) {
    const now = lineCount(git("show", staged ? `:${path}` : `HEAD:${path}`));
    if (now <= limitFor(path)) continue;
    const before = lengthAt(staged ? "HEAD" : base, path);
    if (now >= before) {
      failures.push(
        `  ${path}: ${now} lines (limit ${limitFor(path)}, was ${before})`,
      );
    }
  }

  if (failures.length > 0) {
    console.error(
      "File-length ratchet failed — extract along a clean seam, do not minify:",
    );
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log("File-length ratchet: ok");
}

main();
