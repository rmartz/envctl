---
type: Subsystem
title: Secrets rotation engine
description: How envctl atomically mints, deploys, verifies, and invalidates Firebase and Sentry credentials.
resource: src/lib/rotation.ts
tags: [secrets, rotation, firebase, sentry, vercel, atomicity]
---

# Secrets rotation engine

The engine behind `envctl secrets rotate` and `envctl secrets init`. It manages
the **private** credentials a project needs at runtime — Firebase
service-account keys and the Sentry auth token — as an **atomic** operation: a
new credential is minted and proven live before the old one is invalidated, so
the project is never left without a working key.

This is the realization of the vision's fifth desired-functionality item
([#1](https://github.com/rmartz/envctl/issues/1)). Public (non-secret) variables
are a separate concern — see [config-push](config-push.md).

## Commands

```bash
envctl secrets rotate [firebase|sentry] [OPTS] # rotate existing secrets
envctl secrets init [firebase|sentry] [OPTS]   # bootstrap secrets for a fresh project
```

Both accept `--env <name|development|all>` (default `all`), `--deployment-dir <path>`
(default `deployment`), `--no-invalidate`, and `--refresh-previews`, and both take
an optional leading `firebase`|`sentry` positional. For `init` it selects which
service to initialize (omitted → auto-detect from the deployment config); for
`rotate` it **scopes the run to a single provider** — useful when a project has
both providers in Vercel but you only want to (or can only) rotate one. Omitting
it rotates every provider present in the project.

## Rotate vs. init

The two modes share one engine ([`rotation.ts`](../src/lib/rotation.ts) `run`)
but differ in how they decide what to act on and what they do with the old key:

|                       | **rotate**                                                  | **init**                                                                                |
| --------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Detects services from | keys **already in** the Vercel project                      | public vars in the **deployment config**                                                |
| Firebase signal       | `FIREBASE_SERVICE_ACCOUNT` / `FIREBASE_PRIVATE_KEY` present | `FIREBASE_PROJECT_ID` / `FIREBASE_SA_EMAIL` / `NEXT_PUBLIC_FIREBASE_PROJECT_ID` present |
| Sentry signal         | `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` present             | `SENTRY_ORG` / `SENTRY_PROJECT` present                                                 |
| Precondition          | the secret **exists** (else nothing to rotate)              | the secret does **not** exist (else error — use rotate)                                 |
| Old key               | invalidated after redeploy                                  | none to invalidate                                                                      |

`init`'s service auto-detection lives in
[`secrets-plan.ts`](../src/lib/commands/secrets-plan.ts) (`resolveAutoInit`),
which also validates up front that every config value the chosen service needs
(`FIREBASE_SA_EMAIL`, `FIREBASE_PROJECT_ID`, `SENTRY_ORG`, `SENTRY_PROJECT`) is
present — in the deployment YAML or the shell — and reports **every** gap at
once.

## The atomic flow

For a rotation, [`rotation.ts`](../src/lib/rotation.ts) `run` executes, per
requested target:

0. **Auth preflight** (`assertProviderAuth` in
   [`rotation-preflight.ts`](../src/lib/rotation-preflight.ts)). Before any key
   is minted, auth is asserted for **every provider the run will act on** — GCP
   (via `gcloud`) for Firebase, `SENTRY_AUTH_TOKEN` for Sentry — and the run
   fails fast with an actionable message if one is missing. This is what stops
   a mixed-provider rotation from minting and pushing Firebase's new key and
   only _then_ discovering Sentry is unauthenticated, which would leave a
   partial, unverified state ([#91](https://github.com/rmartz/envctl/issues/91)).
   Scope with the `firebase`|`sentry` positional to rotate just the
   authenticated provider.
1. **Mint & push the new credential.** The old credential remains valid in the
   provider — nothing has been invalidated yet.
   - **Firebase** (`rotateFirebase` / `initFirebase`): `gcloud iam service-accounts keys create`
     mints a fresh JSON key for the configured service account, and it is pushed
     as the `FIREBASE_SERVICE_ACCOUNT` Vercel env var for the target.
   - **Sentry** (`rotateSentry` / `initSentry`): a new client key is created via
     the Sentry API; the id of the previous key is captured for later deletion.
2. **Redeploy and wait.** `triggerAndWaitRedeployments`
   ([deployments.ts](../src/lib/deployments.ts)) redeploys the latest
   production/preview deployment and polls each until Vercel reports `READY`, so
   the new credential is live on real infrastructure before anything is torn
   down. The `development` target has no remote deployment and is skipped.
3. **Invalidate the old credential** (unless `--no-invalidate`). Firebase sweeps
   stray user-managed keys for the service account via
   `invalidateFirebaseKeys`; Sentry deletes the captured old key id. With
   `--no-invalidate`, the old keys are **kept** and printed so they can be
   removed by hand later.

`init` runs steps 1–2 only (there is no prior key to retire) and then reports
completion.

> **Verification depth.** Today "proven working" means the redeploy reached
> Vercel `READY`. Whether that sufficiently proves the _credential itself_
> authenticates — versus only that the build/deploy succeeded — is an open
> design question tracked in
> [#74](https://github.com/rmartz/envctl/issues/74).

> **First-time projects.** On a project with **no prior deployment**, step 2
> finds nothing to redeploy and warns rather than deploying. The credential is
> still pushed; the first real Vercel build consumes it. Verification simply
> does not run until there is something to redeploy.

## Per-environment behavior of `init --env all`

`secrets init --env all` ([secrets.ts](../src/lib/commands/secrets.ts)
`dispatchRotation`) treats the two providers differently, mirroring how each is
scoped:

- **Sentry** is initialized **once**, project-wide, sourced from a single
  environment (the first non-`development` active env).
- **Firebase** is initialized **per Vercel target** (each gets its own key). The
  `development` target shares `staging`'s Firebase project but still receives
  its **own** key, sourced from the staging YAML.

## Prerequisites

Vercel is checked by `checkVercelPrereqs`
([`rotation-preflight.ts`](../src/lib/rotation-preflight.ts)) for every flow, up
front:

- The **Vercel CLI** installed and authenticated (`vercel whoami`).
- A **Vercel token** — `VERCEL_TOKEN` or a `vercel login` session (see
  [auth resolution](env.md#authentication)).

Per-provider auth is then asserted by `assertProviderAuth` (step 0 above) **only
for the providers the run will act on**, after presence detection and any
`firebase`|`sentry` scoping:

- **`gcloud`** installed and authenticated, for any Firebase flow.
- `SENTRY_AUTH_TOKEN` (or `sentry-cli login` session), for any Sentry flow.
- `SENTRY_ORG` / `SENTRY_PROJECT` — additionally required for Sentry key
  **invalidation**.

Run `envctl auth status` to confirm every provider's credential resolves before
starting.

## Options

| Flag                             | Effect                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `firebase` \| `sentry`           | Positional. Scope the run to one provider (rotate) / pick the init target. Default: all present. |
| `--env <name\|development\|all>` | Which deploy environment(s) to act on (default `all`).                                           |
| `--deployment-dir <path>`        | Deployment config directory, resolved against the project root (default `deployment`).           |
| `--no-invalidate`                | Keep the old keys after the redeploy; print them for manual cleanup.                             |
| `--refresh-previews`             | After rotation, redeploy active PR previews so their warm instances pick up the new credential.  |

## Related

- [config-push](config-push.md) — pushing the **public** counterpart vars.
- [env](env.md) — the deployment-config model and environment→target mapping the
  engine reads.
