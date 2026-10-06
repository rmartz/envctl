---
type: Subsystem
title: Config validation (envctl check)
description: Read-only validation that a project's deployment manifest is coherent and deployable, with an optional live completeness check (missing, orphaned, and colliding variables per target).
resource: src/lib/check.ts
tags: [validation, manifest, check, drift, completeness, onboarding]
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
envctl check --live     # also reconcile every target against the provider
envctl check --json     # findings as a JSON array on stdout (CI-friendly)
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

## Live completeness (`--live`)

[`check-live.ts`](../src/lib/check-live.ts) (`checkLive`) adds an opt-in
reconciliation against the deployment provider, behind the `--live` flag because
it requires **network + auth**. It resolves the project's deployment provider and
lists the live env vars once. If auth or project identity is missing, it reports
a single skipped-with-reason finding instead of crashing.

**Required-variable completeness** ([`check-completeness.ts`](../src/lib/check-completeness.ts),
#175) compares every environment's target against its **declared set**: the
manifest's top-level `variables`, the `variableGroups` scoped to it (generated
secrets included), its overlay keys, and the contract vars
(`ServiceProvider.contractVars`, honoring the service's `variables` name map) of
every service scoped to it. A target that silently lacks a credential still
builds READY and ships a broken app, so:

| Finding     | Rule                                                                        | Severity |
| ----------- | --------------------------------------------------------------------------- | -------- |
| `missing`   | declared for the environment but absent on its target                       | error    |
| `orphaned`  | present on a checked target but declared by no environment mapping to it    | warning  |
| `collision` | a service's isolated var resolves to the same value on two distinct targets | error    |

- A missing variable is an **error** (before #175 a missing public variable was
  only a drift warning).
- An orphaned variable's hint is to delete it **and invalidate any credential it
  holds** — a leftover `FIREBASE_SERVICE_ACCOUNT` blob is read by nothing but
  may still be a live key. Vercel system variables (`VERCEL_*`,
  `NEXT_PUBLIC_VERCEL_*`) are never orphans, and a service's `presenceKeys`
  (e.g. the legacy `SENTRY_DSN`) are tolerated without being required.
- A legacy config (no `manifest.yml`) cannot declare services, so every
  registered service's vars are tolerated there but not required.
- Only targets some declared environment maps to are checked; the implicit
  `development` target that `config push` mirrors from staging is not.

**Cross-environment collisions** ([`check-collisions.ts`](../src/lib/check-collisions.ts))
read each service's `ServiceProvider.isolatedVars` — values that identify a
per-environment resource, such as the Firebase project id — and error when two
distinct targets resolve to the same value (one environment pointed at
another's project). Each target's value is the live value (decrypted via the
provider when encrypted), falling back to the environment's declared literal. A
`sensitive` or unreadable live var with no declared literal is skipped with a
`collision-skipped` warning. Environments sharing one target are compared once.

It also runs the **Firebase SA-email drift** check
([`check-firebase.ts`](../src/lib/check-firebase.ts)): a project that still
declares the deprecated `FIREBASE_SA_EMAIL` is compared against the live
credential's `clientEmail` — an **error** when the two name different service
accounts (envctl would mint keys for one SA while the app authenticates as
another), a deprecation **warning** when it merely duplicates the credential
(#103).

It also runs the **Firebase project-id drift** check
([`check-firebase.ts`](../src/lib/check-firebase.ts)): the committed
`FIREBASE_PROJECT_ID` (the GCP project envctl mints keys in) is compared against
the live credential's `projectId` — an **error** when they disagree, because
envctl would mint keys in one GCP project while the app authenticates against
another (#121). Unlike `FIREBASE_SA_EMAIL`, `FIREBASE_PROJECT_ID` is **not**
deprecated: init resolves the project from the target's own declared value
(#127), so a matching committed value is required, not flagged — only drift is.

## Machine-readable output (`--json`)

`--json` replaces the human report with a JSON array on stdout, one object per
finding — `{ severity, kind, env?, target?, key?, message }`. `kind` names the
rule (`missing`, `orphaned`, `collision`, `collision-skipped`), or `general` for
findings that carry no structured context. The command still exits non-zero
when any finding is an error, so it can gate CI or a release.

## Related

- [Deployment manifest schema](manifest.md) — the model `check` validates.
- [Environments and local config](env.md) — the env→target mapping it resolves.
- [Provider registry](providers.md) — the registries it checks `provider:` names against.
