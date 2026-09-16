---
type: Subsystem
title: Config validation (envctl check)
description: Read-only validation that a project's deployment manifest is coherent and deployable, with an optional live-drift check.
resource: src/lib/check.ts
tags: [validation, manifest, check, drift, onboarding]
---

# Config validation (`envctl check`)

`envctl check` validates that a project's deployment configuration is coherent
and deployable **before** a `config push` or `secrets` run fails partway
through. It is entirely **read-only** — it never mutates the manifest, the
overlays, or the provider — and serves the onboarding / validation motivation
behind the config-manifest epic
([#84](https://github.com/rmartz/envctl/issues/84)).

```bash
envctl check            # static validation (offline)
envctl check --live     # also reconcile declared public vars against the provider
envctl [-C <dir>] check # validate a project other than the CWD
```

It collects **every** problem in one pass and reports them together, rather than
stopping at the first, so a single run tells you everything to fix. Each finding
is an **error** or a **warning**; the command exits non-zero when any error is
present, and prints a concise `OK` summary when the config is clean.

## What it checks (static)

Implemented in [`check.ts`](../src/lib/check.ts) (`checkStatic`), reusing the
existing manifest reader, the [env→target resolver](env.md) (#87), and the
[provider registries](providers.md):

| Check                     | Rule                                                                                             | Severity |
| ------------------------- | ------------------------------------------------------------------------------------------------ | -------- |
| Config present            | `deployment/` has a `manifest.yml` or legacy `environments.yml`                                  | error    |
| Manifest parses           | `manifest.yml` is valid YAML (a parse failure is reported, not thrown)                           | error    |
| Environments resolve      | every declared environment resolves to a valid provider target                                   | error    |
| Deployment target mapping | each `deployments[].targets` key is a declared environment; each value is valid for the provider | error    |
| Overlay ↔ declaration     | every `deployment/<env>.yml` overlay matches a declared environment (no orphan overlays)         | error    |
| Providers registered      | every deployment and service `provider:` is registered                                           | error    |
| Scopes                    | service / variable-group `environments:` reference only declared environments                    | error    |
| Provider identity         | the Vercel identity resolves (`.vercel/project.json` or `VERCEL_PROJECT_ID`)                     | warning  |

Provider identity is a **warning**, not an error: a manifest is still valid
without local Vercel linkage — identity is only needed once you actually push or
rotate.

## Live drift (`--live`)

[`check-live.ts`](../src/lib/check-live.ts) (`checkLive`) adds an opt-in
reconciliation against the deployment provider, behind the `--live` flag because
it requires **network + auth**. It resolves the project's deployment provider,
lists the live env vars once, and reports any **declared public variable** that
is not present on its target (drift). If auth or project identity is missing, it
reports a single skipped-with-reason finding instead of crashing.

Scope: `--live` reconciles the **public** variables that
[`config push`](config-push.md) manages, so declared-vs-live stays apples to
apples. Secrets — Firebase/Sentry credentials and generated values — are owned
by the [rotation engine](secrets-rotation.md) and are deliberately out of scope
here.

## Related

- [Deployment manifest schema](manifest.md) — the model `check` validates.
- [Environments and local config](env.md) — the env→target mapping it resolves.
- [Provider registry](providers.md) — the registries it checks `provider:` names against.
