---
type: Subsystem
title: Secrets rotation engine
description: How envctl atomically mints, deploys, verifies, and invalidates Firebase, Sentry and GitHub App credentials.
resource: src/lib/rotation.ts
tags:
  [
    secrets,
    rotation,
    firebase,
    sentry,
    posthog,
    github-app,
    vercel,
    github,
    atomicity,
  ]
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
envctl secrets rotate [<provider>|<service>] [OPTS] # rotate existing secrets
envctl secrets init [<provider>|<service>] [OPTS]   # bootstrap secrets for a fresh project
```

Both accept `--env <name|development|all>` (default `all`), `--deployment-dir <path>`
(default `deployment`), `--deployment <name>`, `--no-invalidate`, and
`--refresh-previews`. Both also take an optional positional naming the service.
That is a provider (`firebase`, `sentry`, `posthog`, `github-app`) or a manifest
service name such as `gate-app`. For `init` it selects which service to
initialize (omitted → auto-detect from the deployment config). For `rotate` it
**scopes the run to a single provider**, useful when a project has several in
Vercel but you only want to (or can only) rotate one. Omitting it rotates every
provider present in the project.

### Shared services across deployments

In a [multi-deployment manifest](manifest.md#deployment-views) (#215):

- **The service picks the deployment.** Run on the root without
  `--deployment`, `secrets init|rotate <service>` acts on the one deployment
  that lists that service. `secrets rotate gate-app` therefore rotates the gate
  App's key in the gate project. A provider keyword with several services of
  that provider must be replaced by the service's name.
- **Shared services need one deployment at a time.** A service several
  deployments list (one Sentry shared by both) is refused without `--deployment`.
  Acting on all of them at once is #216.
- **Rotating a shared service would break the others.** Inside one deployment,
  rotating a service it shares would invalidate a credential the other
  deployments still use, so it is refused. That includes an unscoped `rotate`
  that would reach it. Use `--no-invalidate`, which keeps the old credential
  valid, or scope the rotation to an unshared service.

## Rotate vs. init

The two modes share one engine ([`rotation.ts`](../src/lib/rotation.ts) `run`)
but differ in how they decide what to act on and what they do with the old key:

|                       | **rotate**                                                                       | **init**                                                                                |
| --------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Detects services from | keys **already in** the Vercel project                                           | public vars in the **deployment config**                                                |
| Firebase signal       | the resolved credential vars present ([contract](#firebase-credential-contract)) | `FIREBASE_PROJECT_ID` / `FIREBASE_SA_EMAIL` / `NEXT_PUBLIC_FIREBASE_PROJECT_ID` present |
| Sentry signal         | `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` present                                  | `SENTRY_ORG` / `SENTRY_PROJECT` present                                                 |
| Precondition          | the secret **exists** (else nothing to rotate)                                   | the secret does **not** exist (else error — use rotate)                                 |
| Old key               | invalidated after redeploy                                                       | none to invalidate                                                                      |

`init`'s service auto-detection lives in
[`secrets-plan.ts`](../src/lib/commands/secrets-plan.ts) (`resolveAutoInit`),
which also validates up front that every config value the chosen service needs
(`FIREBASE_SA_EMAIL`, `FIREBASE_PROJECT_ID`, `SENTRY_ORG`, `SENTRY_PROJECT`) is
present — in the deployment YAML or the shell — and reports **every** gap at
once. `FIREBASE_SA_EMAIL` is validated here because init resolves the service
account strictly from the target's **own** declared value (#127; #143) — see
[SA identity](#service-account-identity-firebase_sa_email-is-deprecated).

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
     to Vercel under the project's declared
     [credential contract](#firebase-credential-contract) — the discrete
     projectId/clientEmail/privateKey/privateKeyId vars.
   - **Sentry** (`rotateSentry` / `initSentry`): a new client key is created via
     the Sentry API; the id of the previous key is captured for later deletion.
2. **Redeploy and wait.** `triggerAndWaitRedeployments`
   ([deployments.ts](../src/lib/deployments.ts)) redeploys the latest
   production/preview deployment and polls each until Vercel reports `READY`, so
   the new credential is live on real infrastructure before anything is torn
   down. The `development` target has no remote deployment and is skipped. A
   `CANCELED` redeploy is treated as **benign, not a failure** (#125) — Vercel
   auto-cancels a redeploy when a newer build supersedes it; the pushed vars are
   already saved on the target and apply on its next successful build, so the run
   warns and continues rather than aborting. Only a genuine `ERROR` (or a poll
   timeout) fails the run.
3. **Activate** — work a provider defers until its new value is live. Only
   the [GitHub App](#github-app) uses it: it points the App's webhook at the
   new secret. It runs even with `--no-invalidate`, and never after a failed
   step.
4. **Invalidate the old credential** (unless `--no-invalidate`). Firebase sweeps
   stray user-managed keys for the service account via
   `invalidateFirebaseKeys`; Sentry deletes the captured old key id. With
   `--no-invalidate`, the old keys are **kept** and printed so they can be
   removed by hand later.

`init` runs steps 1–3 only (there is no prior key to retire) and then reports
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

## Firebase credential contract

Which env vars carry the Firebase admin credential is **declared by the project**
in the [manifest](manifest.md), not assumed by envctl. The credential is always
the discrete **`split`** shape — the projectId/clientEmail/privateKey/privateKeyId
vars the app reads directly. A `firebase` service may map each field to a custom
var name (#98); the single-blob `json` shape was removed in #102.

```yaml
services:
  - provider: firebase
    variables: # optional: override the exact var name per field
      privateKey: FB_PRIVATE_KEY
```

[`resolveFirebaseCredential`](../src/lib/firebase-credential.ts) turns that
declaration into a concrete contract — the resolved name for every field
(`projectId` / `clientEmail` / `privateKey` / `privateKeyId`). `secrets.ts` reads
it from the manifest and threads it through the engine; **detect, init, and
rotate all key off these resolved names**, so envctl never provisions a var the
app does not read. With **no manifest / no declaration**, the contract is the
default: the standard `FIREBASE_*` names. An app that reads
`cert({ projectId, clientEmail, privateKey })` boots directly from a pulled
`.env.local` (`env pull` materializes what was written); `privateKeyId` tracks
the active key for the sweep.

### Service-account identity (`FIREBASE_SA_EMAIL` is deprecated)

The service account envctl mints/rotates keys for is the **same** identity the
app reads from the credential's `clientEmail`:

- **rotate** reads the SA identity from the target's **own** live credential and
  never requires `FIREBASE_SA_EMAIL` (#103).
- **init** cold-inits a blank target from **that target's own** declared
  `FIREBASE_SA_EMAIL` (its `deployment/{env}.yml`, or the shell). It **never**
  derives the SA from another target's credential or a local `.env.local`
  (#126): deriving across targets pushed one environment's Firebase project
  credential to another (e.g. staging → production). As a guard, init **refuses**
  when the SA email's project disagrees with the target's declared
  `FIREBASE_PROJECT_ID`. Declaring `FIREBASE_SA_EMAIL` emits a **deprecation
  warning** — it is the cold-start input only; deterministic SA discovery to
  remove even that is tracked in
  [#70](https://github.com/rmartz/envctl/issues/70).

`FIREBASE_SA_EMAIL` is therefore **deprecated, not removed**. A project that
still declares it and lets it drift from the credential's `clientEmail` is
flagged by [`envctl check --live`](check.md).

## Generated secrets

Beyond provider credentials, a project can declare **project-owned generated
secrets** in the manifest — a variable with `generate: true` (top-level ⇒ all
environments, or inside a scoped `variableGroup`). envctl mints these itself; the
value never appears in `manifest.yml`, an overlay, or any committed file — only in
the deployment target. The motivating case is a Vercel-cron `CRON_SECRET`.

[`generated-secrets.ts`](../src/lib/generated-secrets.ts):

- **Format (no knobs, v1):** one strong default — 32 random bytes, base64url —
  minted **distinct per environment** (production's value ≠ staging's).
- **`secrets init`** mints a value for each scoped target that lacks one, and is
  **idempotent**: an existing value is left untouched.
- **`secrets rotate`** re-mints every scoped value. There is no external
  credential to invalidate, so rotation is complete once the new value is pushed
  and proven live by the redeploy.
- **Shared redeploy (atomicity, #74):** the generated values are pushed **before**
  the provider dispatch, so the provider rotation's single redeploy proves them
  live too. A project with only generated secrets (no Firebase/Sentry) triggers
  its own redeploy instead.

Selection is manifest-declared (the `generate` source), independent of the
presence-driven provider detection above.

## Environment-scoped services

A service can be declared to exist only in a subset of environments (#89) — e.g.
an expensive tracking service that runs in production only:

```yaml
services:
  - provider: firebase
    environments: [production]
```

`serviceScopeTargets` maps a service's `environments` to its provider targets.
`run` then applies the scope two ways:

- **Selection:** a service whose scope does **not** intersect the run's targets
  is skipped entirely — not authenticated, minted, or rotated (so a prod-only
  service is a silent no-op in a staging run, never a "nothing to rotate" error).
- **Per-target:** a service that partially overlaps (e.g. a prod-only service in
  an `--env all` run) acts only on its in-scope targets — `init`/`rotate` receive
  the `allowedTargets` set and skip the rest.

A service with **no** `environments` is unscoped and applies to every
environment (the default). Scoping is **service-/group-level only** — individual
variables inherit their container's scope and cannot override it; ungrouped
top-level variables default to all environments. Variable-group scoping for
[generated secrets](#generated-secrets) works the same way (`group.environments`).

## GitHub Actions secrets

CI often needs a value envctl manages, such as a Firebase credential for e2e
tests or a generated `CRON_SECRET`. A project declares those in the manifest's
`github` block ([schema](manifest.md#the-model)), and envctl copies each value
to a GitHub Actions secret whenever it pushes that variable to the declared
environment's target (#198):

```yaml
github:
  repo: acme/app # optional; default: the working directory's repo
  secrets:
    - variable: FIREBASE_PRIVATE_KEY
      environment: staging
      name: STAGING_FIREBASE_PRIVATE_KEY # optional; default: the variable name
      githubEnvironment: e2e # optional; default: a repository secret
```

[`github-secrets.ts`](../src/lib/github-secrets.ts) wraps the deployment
provider so every `setEnvForTarget` write, which is the path all provider and
generated secrets take, is followed by `gh secret set` for each matching
declaration. The value goes in on stdin, so it never appears in the process
list.

- **Order.** The GitHub write happens at push time, after the Vercel write and
  before the redeploy and invalidation. If it fails, the run stops while the
  old credential is still valid.
- **Auth.** `gh` must be authenticated (`GH_TOKEN`, `GITHUB_TOKEN`, or
  `gh auth login`). The preflight checks this before anything is minted,
  whenever a declared secret's target is in the run.
- **Plan.** The run logs each GitHub secret it will update before minting.
- **Verification.** GitHub secrets can't be read back, so "proven working"
  only means the write succeeded. [`check --live`](check.md) reports a declared
  secret that's missing.

## PostHog (manual rotation)

PostHog's only secret is the optional `POSTHOG_PERSONAL_API_KEY` (server-side
flag local evaluation or query API). The PostHog API won't create, roll, or
delete personal API keys for a caller that authenticates with a personal API key.
Only a logged-in browser session can do that. So envctl can't mint a
replacement, and PostHog is a [manual-only provider](providers.md#manual-only-sources-manualsteps):

- `secrets init posthog` and `secrets rotate posthog` refuse up front, before
  anything is written, and print the manual steps.
- An unscoped `secrets rotate` rotates the other providers and prints the
  PostHog steps as a warning when the personal key is present.
- `secrets init` (auto or `all`) never selects PostHog.

To rotate by hand without downtime: create a new key with the same scopes in
PostHog → Settings → Personal API keys. Don't use "Roll", which kills the old
value before the new one is deployed. Then replace the var on each target with
`vercel env rm` / `vercel env add … --sensitive`, redeploy and verify, and
delete the old key in PostHog.

The public project key and host aren't secrets. They live in
`deployment/{env}.yml` and are pushed by [`config push`](config-push.md), which
refuses when two environments share a project key.

## GitHub App

The `github-app` provider (#201) manages a Vercel-hosted GitHub App server's
two secrets, the App private key and the webhook secret, and keeps the App's
webhook config on GitHub in step with them. Declare it in `manifest.yml`:

```yaml
services:
  - provider: github-app
    environments: [production] # optional scope
    webhookUrl: https://my-app.vercel.app/api/webhook
    variables: # optional renames; defaults shown in the table
      clientId: PR_LIFECYCLE_CLIENT_ID
      privateKey: PR_LIFECYCLE_PRIVATE_KEY
      webhookSecret: PR_LIFECYCLE_WEBHOOK_SECRET
```

| Field           | Default var                 | Kind                                       |
| --------------- | --------------------------- | ------------------------------------------ |
| `clientId`      | `GITHUB_APP_CLIENT_ID`      | public, in `deployment/{env}.yml`          |
| `privateKey`    | `GITHUB_APP_PRIVATE_KEY`    | secret, pushed as a Vercel sensitive var   |
| `webhookSecret` | `GITHUB_APP_WEBHOOK_SECRET` | secret, generated, pushed as sensitive too |

The Client ID is a public literal pushed by [`config push`](config-push.md).
envctl also reads it from the deployment config of an in-scope environment and
signs the App JWT with it as the `iss`. GitHub accepts the Client ID there in
place of the numeric App ID.

- **`secrets init github-app --private-key-file <pem>`** reads the private key
  from the PEM file and mints a webhook secret (the
  [generated-secret](#generated-secrets) format). It pushes both to every
  in-scope target as sensitive vars (encrypted on `development`, where Vercel
  has no sensitive type), redeploys, then sets the App's webhook URL and secret
  with `PATCH /app/hook/config`. The key is only ever read from the file: it is
  never taken from argv or the environment, and never echoed or logged. A
  missing file or a file that isn't an RSA private key PEM fails the
  preflight.
- **`secrets rotate github-app --private-key-file <pem>`** treats the PEM as
  the App's current key (#206). It runs in this order: mint a webhook secret,
  push it and the PEM to Vercel, redeploy until `READY`, prove the key by
  calling `GET /app` with an App JWT it signs, then `PATCH /app/hook/config`.
  If any earlier step fails, GitHub keeps the old secret. Between the redeploy
  and the PATCH, deliveries signed with the old secret are rejected; redeliver
  them from the App's Advanced settings page if needed.
- **Rotating the private key.** GitHub has no API to create an App private
  key; keys are generated only on the App's settings page. So generate the new
  key there, then pass its PEM to `secrets rotate github-app`. Once the key is
  proven, rotate logs its fingerprint (`SHA256:…`, as the settings page shows
  it). Delete the key it replaced, but keep any key another consumer, such as
  a GitHub Actions secret, still uses. envctl never deletes App keys.
  Passing the current key instead just re-pushes it alongside the new webhook
  secret.
- An unscoped `secrets rotate` includes the webhook secret when it is present
  (so it also needs `--private-key-file`). Auto-detecting `secrets init`
  selects `github-app` only when the manifest declares the service. `init all`
  never selects it: it means Firebase and Sentry.
- **Precondition: the App's webhook must be active.** Check **Active** and set
  any URL under the App's settings → Webhook before the first `init`. GitHub
  returns 404 on `/app/hook/config` for an App without an active webhook.
- The preflight fails, before anything is minted, when `--private-key-file`,
  the Client ID, or `webhookUrl` is missing. It then calls
  `GET /app/hook/config` as the App. A 404 fails with the
  inactive-webhook remedy, and a 401 with a Client ID / private key mismatch
  hint, so neither leaves Vercel holding a secret GitHub lacks (#203).
- Recovering from a failed `init`: once the vars exist, a re-run of `init`
  refuses, so finish with `secrets rotate github-app`, which re-mints the
  webhook secret and PATCHes GitHub.

Out of scope: GitHub doesn't let an API change an App's permissions or event
subscriptions after it's created. Set those on the App's settings page.

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
- `SENTRY_ORG` / `SENTRY_PROJECT` — required for any Sentry rotation or
  initialization (to query and create keys); also required for key **invalidation**.
- `--private-key-file`, a Client ID in the deployment config, and the
  service's `webhookUrl`, for any [GitHub App](#github-app) flow.
- **`gh`** authenticated (`GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth login`), when
  the manifest declares a [GitHub Actions secret](#github-actions-secrets) on a
  target the run writes.

Run `envctl auth status` to confirm every provider's credential resolves before
starting.

## Options

| Flag                             | Effect                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `firebase` \| `sentry` \| …      | Positional. Scope the run to one provider (rotate) / pick the init target. Default: all present. |
| `--env <name\|development\|all>` | Which deploy environment(s) to act on (default `all`).                                           |
| `--deployment-dir <path>`        | Deployment config directory, resolved against the project root (default `deployment`).           |
| `--deployment <name>`            | Act on that directory's named deployment (its [view](manifest.md#deployment-views)).             |
| `--no-invalidate`                | Keep the old keys after the redeploy; print them for manual cleanup.                             |
| `--refresh-previews`             | After rotation, redeploy active PR previews so their warm instances pick up the new credential.  |
| `--private-key-file <path>`      | GitHub App private key PEM, resolved against the shell's cwd. Required for `github-app`.         |

## Related

- [config-push](config-push.md) — pushing the **public** counterpart vars.
- [env](env.md) — the deployment-config model and environment→target mapping the
  engine reads.
