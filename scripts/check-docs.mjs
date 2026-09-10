#!/usr/bin/env node
/**
 * docs/ knowledge-bundle check — enforces two OKF invariants across `docs/`
 * (see AGENTS.md → Documentation):
 *
 *   1. OKF frontmatter — every non-index `.md` file starts with a YAML
 *      frontmatter block whose OKF-required `type` field is present and
 *      non-empty. A reserved `index.md` is exempt (OKF §8): it carries no
 *      frontmatter, save an optional bundle-root `okf_version` key — any other
 *      key (including `type`) is a violation.
 *   2. Index navigability — every directory on the path to a doc carries an
 *      `index.md`; each `index.md` links every non-index `.md` in its own
 *      directory, and links the `index.md` of every immediate subdirectory. So
 *      every page is reachable by navigation from `docs/index.md`
 *      (`docs/index.md` → `docs/example/index.md` → `docs/example/feature.md`).
 *
 * Exits 0 when `docs/` is compliant, 1 when any violation is found.
 *
 * Usage: node scripts/check-docs.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_ROOT = join(repoRoot, "docs");
const INDEX = "index.md";

function fileExists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

// Collect every `.md` file under docs/, grouped by containing directory.
function collectMarkdown(dir, byDir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      collectMarkdown(join(dir, entry.name), byDir);
    } else if (entry.name.endsWith(".md")) {
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(entry.name);
    }
  }
  return byDir;
}

// Every directory that must carry an index.md: each directory containing a
// `.md`, plus all of its ancestors up to and including DOCS_ROOT — the chain a
// reader walks from the bundle root down to any page.
function requiredIndexDirs(byDir) {
  const dirs = new Set();
  for (const start of byDir.keys()) {
    let dir = start;
    while (dir.startsWith(DOCS_ROOT)) {
      dirs.add(dir);
      if (dir === DOCS_ROOT) break;
      dir = dirname(dir);
    }
  }
  return dirs;
}

// OKF frontmatter validation. Returns an error string, or undefined when the
// file opens with a closed YAML frontmatter block carrying a non-empty `type`.
function frontmatterError(path) {
  const text = readFileSync(path, "utf8");
  if (!/^---\r?\n/.test(text)) {
    return "missing OKF frontmatter (file must open with a `---` block)";
  }
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) {
    return "OKF frontmatter block is never closed with a `---` fence";
  }
  let data;
  try {
    data = loadYaml(match[1]);
  } catch (err) {
    return `OKF frontmatter is not valid YAML: ${err.message}`;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return "OKF frontmatter must be a YAML mapping of fields";
  }
  if (typeof data.type !== "string" || data.type.trim().length === 0) {
    return "OKF frontmatter is missing the required `type` field";
  }
  return undefined;
}

// Index-file frontmatter validation (OKF §8 / §11). A reserved `index.md` is
// exempt from the `type` requirement: it may carry no frontmatter at all, or a
// frontmatter block whose only key is `okf_version`. Returns an error string
// when the file carries frontmatter with any other key (e.g. `type`).
function indexFrontmatterError(path) {
  const text = readFileSync(path, "utf8");
  // No frontmatter is the canonical shape for an index file.
  if (!/^---\r?\n/.test(text)) {
    return undefined;
  }
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) {
    return "OKF frontmatter block is never closed with a `---` fence";
  }
  let data;
  try {
    data = loadYaml(match[1]);
  } catch (err) {
    return `OKF frontmatter is not valid YAML: ${err.message}`;
  }
  // An empty block carries no keys — treat it as no frontmatter.
  // js-yaml returns undefined (not null) for an empty document, so use == null.
  if (data == null) {
    return undefined;
  }
  if (typeof data !== "object" || Array.isArray(data)) {
    return "OKF frontmatter must be a YAML mapping of fields";
  }
  // Only the bundle-root index.md may carry okf_version (OKF §8);
  // subdirectory index.md files must carry no frontmatter at all.
  const isBundleRoot = dirname(path) === DOCS_ROOT;
  const extra = isBundleRoot
    ? Object.keys(data).filter((key) => key !== "okf_version")
    : Object.keys(data);
  if (extra.length > 0) {
    return isBundleRoot
      ? "index.md must not carry OKF frontmatter beyond `okf_version` " +
          `(OKF §8); disallowed key(s): ${extra.join(", ")}`
      : "subdirectory index.md must carry no frontmatter at all (OKF §8); " +
          `disallowed key(s): ${extra.join(", ")}`;
  }
  return undefined;
}

// The `target` of every `[text](target)` markdown link in the text.
function linkTargets(text) {
  const targets = [];
  const re = /\]\(([^)]+)\)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    targets.push(match[1].trim().split(/\s+/)[0]);
  }
  return targets;
}

// Resolve a link target to the absolute path it points at, or undefined when it
// is external (has a scheme) or empty. A bundle-relative `/…` target resolves
// from DOCS_ROOT; everything else from the linking index's directory. A target
// naming a directory resolves to that directory's index.md, so `example/` and
// `example/index.md` are equivalent.
function resolveTarget(indexDir, target) {
  const clean = target.replace(/[?#].*$/, "").trim();
  if (clean === "" || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return undefined;
  const fromRoot = clean.startsWith("/");
  const abs = resolve(
    fromRoot ? DOCS_ROOT : indexDir,
    fromRoot ? clean.slice(1) : clean,
  );
  try {
    if (statSync(abs).isDirectory()) return join(abs, INDEX);
  } catch {
    // Not a directory on disk — use the resolved path as-is.
  }
  return abs;
}

function checkFrontmatter(byDir, violations) {
  for (const [dir, files] of byDir) {
    for (const name of files) {
      const error =
        name === INDEX
          ? indexFrontmatterError(join(dir, name))
          : frontmatterError(join(dir, name));
      if (error)
        violations.push(`${relative(repoRoot, join(dir, name))}: ${error}`);
    }
  }
}

function checkNavigation(byDir, violations) {
  const required = requiredIndexDirs(byDir);
  for (const dir of required) {
    const indexPath = join(dir, INDEX);
    if (!fileExists(indexPath)) {
      violations.push(
        `${relative(repoRoot, dir)}: missing ${INDEX} (needed to navigate this directory)`,
      );
      continue;
    }
    const relIndex = relative(repoRoot, indexPath);
    const linked = new Set(
      linkTargets(readFileSync(indexPath, "utf8"))
        .map((target) => resolveTarget(dir, target))
        .filter((path) => path !== undefined),
    );

    // Every non-index page in this directory must be linked from index.md.
    for (const name of byDir.get(dir) ?? []) {
      if (name !== INDEX && !linked.has(join(dir, name))) {
        violations.push(`${relIndex}: does not link \`${name}\``);
      }
    }

    // Every immediate subdirectory's index.md must be linked from index.md.
    for (const childDir of required) {
      if (dirname(childDir) === dir && !linked.has(join(childDir, INDEX))) {
        violations.push(
          `${relIndex}: does not link subdirectory index \`${relative(dir, join(childDir, INDEX))}\``,
        );
      }
    }
  }
}

function main() {
  if (!fileExists(DOCS_ROOT)) {
    console.log("Docs check: no docs/ directory — nothing to check.");
    return;
  }
  const byDir = collectMarkdown(DOCS_ROOT, new Map());
  const violations = [];
  checkFrontmatter(byDir, violations);
  checkNavigation(byDir, violations);

  if (violations.length > 0) {
    console.error("docs/ OKF convention violations:\n");
    for (const violation of violations.sort())
      console.error(`  ✗ ${violation}`);
    console.error(
      `\n${violations.length} violation(s). Every non-index docs/ page needs OKF` +
        ` frontmatter with a \`type\` (a reserved ${INDEX} carries none beyond` +
        ` \`okf_version\`), and every page must be reachable via ${INDEX} links` +
        ` from docs/${INDEX}.`,
    );
    process.exit(1);
  }

  console.log("Docs check: ok");
}

main();
