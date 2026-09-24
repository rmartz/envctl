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

- [Bootstrap](bootstrap.md) — one-command end-to-end setup: push public config,
  initialize any missing secrets, and pull a local dotenv (`bootstrap`).
- [Environments and local config](env.md) — the in-repo deployment-config model,
  defining environments (`init` / `env add` / `env list`), and auth resolution.
- [Deployment manifest schema](manifest.md) — the typed `manifest.yml` model,
  parser (with legacy back-compat), and comment-preserving writer the
  config-manifest epic builds on (foundation; not yet wired to commands).
- [Config push](config-push.md) — upserting public (non-secret) env vars from
  YAML to Vercel targets.
- [Config pull](config-pull.md) — materializing a local dotenv from an
  environment for local testing (`config pull`; the inverse of `config push`).
- [Secrets rotation engine](secrets-rotation.md) — atomically minting,
  deploying, verifying, and invalidating Firebase and Sentry credentials
  (`secrets rotate` / `secrets init`).
- [Config validation](check.md) — read-only checks that a project's deployment
  manifest is coherent and deployable, with an optional live-drift check
  (`check` / `check --live`).
- [Provider registry](providers.md) — the `DeploymentProvider` and
  `ServiceProvider` interfaces and registries that make hosting sinks and secret
  sources pluggable by the manifest `provider:` name.

Other runtime subsystems (the Vercel API client, deployment orchestration) are
not yet documented here; pages are added as those modules are next touched.

## Scripts

The repo-hygiene CI gates (AGENTS.md/CLAUDE.md pairing, OKF frontmatter +
`index.md` navigability + link integrity, action pins, package pins, conflict
markers) now run via [`rmartz/repo-hygiene-action`](https://github.com/rmartz/repo-hygiene-action)
(see `.github/workflows/repo-hygiene.yml`, configured in `.repo-hygiene.yml`)
rather than local scripts. Two local gate scripts remain:
`scripts/check-file-length.mjs` (the file-length ratchet, not yet documented here;
a page is added when it is next touched) and `scripts/verify-changelog-render.mjs`,
which the `Release notes render` CI job runs to prove the changelog preset and
writer can render release notes before a release depends on them.
