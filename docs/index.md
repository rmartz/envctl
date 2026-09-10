---
okf_version: "0.2"
---

# envctl documentation

Reference pages for envctl's scripts and subsystems, in Google's Open Knowledge
Format (OKF). One page per script or subsystem.

## Conventions

- [OKF documentation format](okf-format.md) — what OKF is, how this bundle uses
  it, and a pointer to the authoritative Google spec.

## Runbooks

- [Applying config and minting/rotating secrets on a Vercel deploy](runbook-vercel-deploy.md)
  — the scenario-driven playbook (cold-start, mint, rotate, add a provider,
  public-var change, local pull) for operating envctl against a Firebase +
  Next.js Vercel project.

## Subsystems

- [Environments and local config](env.md) — the in-repo deployment-config model,
  defining environments (`init` / `env add` / `env list`), materializing a local
  dotenv (`env pull`), and auth resolution.
- [Config push](config-push.md) — upserting public (non-secret) env vars from
  YAML to Vercel targets.
- [Secrets rotation engine](secrets-rotation.md) — atomically minting,
  deploying, verifying, and invalidating Firebase and Sentry credentials
  (`secrets rotate` / `secrets init`).

Other runtime subsystems (the Vercel API client, deployment orchestration) are
not yet documented here; pages are added as those modules are next touched.

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
