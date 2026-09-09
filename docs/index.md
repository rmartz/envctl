---
type: Index
title: envctl documentation
description: Reference pages for envctl's scripts and subsystems.
---

# envctl documentation

Reference pages for envctl's scripts and subsystems, in Google's Open Knowledge
Format (OKF). One page per script or subsystem.

## Conventions

- [OKF documentation format](okf-format.md) — what OKF is, how this bundle uses
  it, and a pointer to the authoritative Google spec.

## Scripts

- [check-agents-md](check-agents-md.md) — enforces the AGENTS.md / CLAUDE.md
  pairing convention (bare `@AGENTS.md` wrapper).
- [check-docs](check-docs.md) — enforces OKF frontmatter and `index.md`
  navigability across this `docs/` bundle.
- [check-release-age](check-release-age.md) — deterministic dependency
  release-age (cooldown) CI gate.

Other CI gate scripts under `scripts/` (`check-file-length.mjs`,
`check-package-pins.mjs`, `check-action-pins.mjs`) are not yet documented here;
pages are added as those scripts are next touched.
