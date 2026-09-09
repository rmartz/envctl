---
type: Script
title: check-agents-md
description: Fails CI unless every AGENTS.md is paired with a companion CLAUDE.md whose only content is the bare `@AGENTS.md` import.
resource: scripts/check-agents-md.mjs
tags: [documentation, agents, ci, validation]
---

# check-agents-md

Enforces the agent directive-file convention from `AGENTS.md`: directives are
authored once, in `AGENTS.md`, and `CLAUDE.md` is a thin wrapper that imports
them.

Maintaining `CLAUDE.md` as a full copy of `AGENTS.md` invites silent drift — the
two files diverge and it is no longer clear which one an agent actually reads.
This check makes `AGENTS.md` the single source of truth and `CLAUDE.md` a bare
`@AGENTS.md` import, so there is exactly one place to edit and no copy to fall
out of sync.

## Usage

```bash
node scripts/check-agents-md.mjs
pnpm run check:agents-md
```

It runs in CI as the **Agent directive files** job in
`.github/workflows/agents-md.yml`, scoped by path filters to run only when an
`AGENTS.md` / `CLAUDE.md` file (or this validator / its workflow) changes — a
whole-tree check needs no run otherwise.

## What it checks

Walks the repository (skipping `.git`, `.git-worktrees`, `node_modules`, and
build output), groups `AGENTS.md` / `CLAUDE.md` files by directory, and for each
directory asserts:

- **Pairing** — an `AGENTS.md` must have a companion `CLAUDE.md`, and a
  `CLAUDE.md` must have a companion `AGENTS.md`.
- **Bare wrapper** — a `CLAUDE.md` must contain only the single import line
  `@AGENTS.md` (blank lines aside); any other text is a violation.
- **No symlink** — a `CLAUDE.md` must be a real file, not a symlink to
  `AGENTS.md`.

Exits 0 when the whole tree is compliant; exits 1 with a `path: reason` line per
violation.

## Requires

- `node` (walks the working tree only — no dependency install needed)

## Related

- [check-release-age](check-release-age.md) — sibling standalone CI-gate
  validator.
