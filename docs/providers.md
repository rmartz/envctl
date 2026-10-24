---
type: Subsystem
title: Provider registry
description: The DeploymentProvider and ServiceProvider interfaces and their registries, keyed by the manifest provider discriminant, that make envctl's hosting sinks and secret sources pluggable by name.
resource: src/lib/providers/service.ts
tags: [providers, registry, provider-agnostic, deployment, secrets]
---

# Provider registry

The provider-agnostic core (epic [#84](https://github.com/rmartz/envctl/issues/84),
issue [#86](https://github.com/rmartz/envctl/issues/86)): two interfaces behind
registries keyed by the manifest `provider:` discriminant, so adding a hosting
target or a secret source is a new implementation registered by name rather than
edits threaded through `config push`, the rotation engine, `firebase`, and
`sentry`.

## DeploymentProvider — the hosting sink

[`DeploymentProvider`](../src/lib/providers/deployment.ts) is what a deployment
target must do: resolve project identity, read/write env vars for a target, and
trigger + await a redeploy (plus refresh previews). **Vercel** is the only
implementation today — it wraps the existing `VercelClient` + `deployments.ts`,
delegating so their behavior is unchanged.

- `resolveDeploymentProvider(name, workingDir)` maps a `provider:` name to an
  implementation, erroring with the offending value when it is not registered.
- `resolveProjectDeployment(deploymentDir, workingDir)` reads the manifest's
  first `deployments[]` entry and resolves that provider, defaulting to `vercel`
  for a legacy config (where `parseManifest` synthesizes a vercel deployment).

`config push` and the secrets rotation engine obtain their sink through the
registry rather than constructing `VercelClient` directly.

## ServiceProvider — the secret source

[`ServiceProvider`](../src/lib/providers/service.ts) is what a rotatable secret
source must do: report the env-var keys that signal it is provisioned
(`presenceKeys`), declare its auth slot for the fail-fast preflight, `init` a
fresh credential, and `rotate` — returning a `ServiceRotation` handle that knows
how to `invalidate` the retired credential (after the redeploy proves the new one
live) and how to describe it under `--no-invalidate`. **Firebase** and **Sentry**
implement it, wrapping the existing `firebase.ts` / `sentry.ts` functions (whose
`client` parameter is now the `DeploymentProvider` interface). **GitHub App**
is a third automatable source.

`init` may return, and `ServiceRotation` may carry, an `activate()` hook: work
the engine runs after the redeploy is `READY` and before invalidation, whether
or not `--no-invalidate` is set. An optional async `preflight(ctx)` runs for
every acting source after the auth preflight and before anything is minted, for
remote checks such as GitHub App webhook reachability. A source sets
`explicitInit` to stay out of `init all`.

Two optional members feed [`envctl check --live`](check.md):

- `contractVars(ctx)` — every env var the service provisions on each in-scope
  target (Firebase: all four credential fields under their manifest-mapped
  names; Sentry: `NEXT_PUBLIC_SENTRY_DSN`). `check --live` requires these on
  each target the service is scoped to; when omitted it falls back to
  `presenceKeys`. `presenceKeys` stay tolerated (not orphaned) either way, so a
  legacy alias such as `SENTRY_DSN` is accepted but not required.
- `isolatedVars(ctx)` — env vars whose values must differ across environments
  (e.g. a project id); `check --live` errors when two environments resolve to
  the same value. Firebase returns its project-id var.

- `serviceProviders()` returns the registered sources in a fixed order
  (Firebase, Sentry, PostHog, then GitHub App) — the order in which they act, so the
  auth preflight and rotation sequence match the pre-registry behavior.
- `resolveServiceProvider(name)` resolves one by its manifest name, erroring on
  an unknown value.

Two optional members describe a source's variable contract for `check --live`:
`contractVars` (every var the service provisions on each in-scope target;
falls back to `presenceKeys`) and `isolatedVars` (vars whose values must differ
across environments, such as a project id).

### Manual-only sources (`manualSteps`)

A source whose secret its own API cannot mint or delete sets `manualSteps`,
returning the hand-rotation instructions. The engine never calls `init`/`rotate`
on it: an explicit `secrets init <name>` / `secrets rotate <name>` is refused up
front with those steps, `init all` skips it, and an unscoped `rotate` that finds
its secret present prints the steps as a warning while rotating the other
sources. It takes no auth-preflight slot (`authKey: "none"`).

### PostHog

[`providers/posthog.ts`](../src/lib/providers/posthog.ts) with its var contract
in [`posthog.ts`](../src/lib/posthog.ts) (#173). Fields, overridable via the
manifest `services[].variables` field→name map like Firebase's:

| Field            | Default var                | Kind             |
| ---------------- | -------------------------- | ---------------- |
| `projectKey`     | `NEXT_PUBLIC_POSTHOG_KEY`  | public           |
| `host`           | `NEXT_PUBLIC_POSTHOG_HOST` | public           |
| `personalApiKey` | `POSTHOG_PERSONAL_API_KEY` | secret, optional |

```yaml
services:
  - provider: posthog
    variables:
      personalApiKey: POSTHOG_SERVER_KEY # optional rename
```

- The project key and host are public literals in `deployment/{env}.yml`,
  pushed by [`config push`](config-push.md). Each environment uses its own
  PostHog project; `config push` refuses when two environments on different
  targets share a project key.
- `presenceKeys` is the personal API key, so a project using only the public
  key has nothing to rotate. `contractVars` is the project key and host;
  `isolatedVars` is the project key.
- PostHog is **manual-only**. Its API rejects creating, rolling, listing, or
  deleting personal API keys when the caller authenticates with a personal API
  key: `PersonalApiKeySelfAccessPermission` in PostHog's
  [`posthog/api/personal_api_key.py`](https://github.com/PostHog/posthog/blob/master/posthog/api/personal_api_key.py)
  allows only `retrieve` for that kind of caller. See
  [Secrets rotation → PostHog](secrets-rotation.md#posthog-manual-rotation).

### GitHub App

[`providers/github-app.ts`](../src/lib/providers/github-app.ts) with its
contract, PEM loading, App JWT and webhook PATCH in
[`github-app.ts`](../src/lib/github-app.ts) (#201). Fields `clientId`
(public), `privateKey` and `webhookSecret` (secrets) default to
`GITHUB_APP_*` names and are renamed through `services[].variables`; the
service's `webhookUrl` names the URL the App's webhook points at.

- `presenceKeys` and `contractVars` are the private key and webhook secret.
- `authKey: "github-app"`: the preflight requires `--private-key-file` (a
  readable RSA PEM), the Client ID, and `webhookUrl`. Its async `preflight`
  then calls `GET /app/hook/config` as the App, so an inactive webhook (404) or
  a rejected JWT (401) fails the run before any secret is minted (#203).
- `init` pushes both secrets as sensitive vars; `rotate` re-mints the webhook
  secret and warns with the private key's manual steps. Both return an
  `activate()` that PATCHes `/app/hook/config`, so GitHub changes only after
  the redeploy succeeds.
- `explicitInit`: selected by name, or by auto-detection when the manifest
  declares it, never by `init all`. See
  [Secrets rotation → GitHub App](secrets-rotation.md#github-app).

## How the rotation engine iterates them

[`rotation.ts`](../src/lib/rotation.ts) `run` resolves the deployment provider
from the registry, then iterates `serviceProviders()` generically:

1. **Detect** which sources are present from the (target-scoped) Vercel env keys.
2. **Guard** — `init` errors if a selected source already exists; a scoped
   `rotate` errors if the named source is absent; an unscoped `rotate` errors if
   no automatable source is present. Manual-only sources are refused or warned
   about here and never act.
3. **Auth preflight** (`assertProviderAuth`) for exactly the acting sources,
   before any key is minted (#91).
4. **init** each acting source, or **rotate** each and collect its
   `ServiceRotation`; then a single **redeploy** proves the new credentials live.
5. **activate** each init or rotation that returned an `activate()` hook.
6. **invalidate** each rotation (or print its retired-key warnings under
   `--no-invalidate`).

The engine never names Firebase or Sentry — it works entirely against the
`ServiceProvider` interface and the registry order.

## Related

- [Secrets rotation engine](secrets-rotation.md) — the atomic mint → deploy →
  verify → invalidate flow these providers plug into.
- [Deployment manifest schema](manifest.md) — the `provider:` discriminant the
  registries key off.
- Epic [#84](https://github.com/rmartz/envctl/issues/84); registry issue
  [#86](https://github.com/rmartz/envctl/issues/86).
