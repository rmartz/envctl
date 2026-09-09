---
type: Script
title: check-docs
description: Fails CI unless every docs/ page has OKF frontmatter and is reachable by index.md navigation from docs/index.md.
resource: scripts/check-docs.mjs
tags: [documentation, okf, ci, validation]
---

# check-docs

Enforces the structural integrity of the `docs/` knowledge bundle described in
`AGENTS.md` → Documentation: every page is written in Google's Open Knowledge
Format (OKF) and the bundle is fully navigable from its root `index.md`.

Undocumented pages and dead-end files defeat the point of a knowledge bundle —
an agent (or a person) that starts at `docs/index.md` and follows links should
be able to reach every page, and every page should announce what it is through
OKF frontmatter. This check keeps both true as the bundle grows.

## Usage

```bash
node scripts/check-docs.mjs
pnpm run check:docs
```

It runs in CI as the **Docs** job in `.github/workflows/docs.yml`, scoped by path
filters to run only when a `docs/**` file, this validator, or its workflow
changes.

## What it checks

Walks `docs/` and asserts:

- **OKF frontmatter** — every `.md` file opens with a closed YAML frontmatter
  block (`---` … `---`) that parses as a mapping and carries a non-empty `type`
  field (the only field OKF v0.2 requires). Malformed or missing frontmatter is
  a violation.
- **Index navigability** — every directory on the path to a page carries an
  [`index.md`](index.md); each `index.md` links every non-index `.md` in its own
  directory, and links the `index.md` of every immediate subdirectory. This
  guarantees a reader can navigate `docs/index.md` → `docs/example/index.md` →
  `docs/example/feature.md` to reach any page. A link target naming a directory
  (`example/`) is treated as that directory's `index.md`; bundle-relative
  targets (`/foo/bar.md`) resolve from `docs/`.

Exits 0 when the whole bundle is compliant; exits 1 with a `path: reason` line
per violation.

## Requires

- `node` and `js-yaml` (already a project dependency) — run after `pnpm install`.

## Related

- [check-agents-md](check-agents-md.md) — enforces the sibling AGENTS.md /
  CLAUDE.md pairing convention.
- [check-release-age](check-release-age.md) — another standalone CI-gate
  validator.
