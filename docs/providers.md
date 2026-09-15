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
`client` parameter is now the `DeploymentProvider` interface).

- `serviceProviders()` returns the registered sources in a fixed order
  (Firebase, then Sentry) — the order in which they act, so the auth preflight
  and rotation sequence match the pre-registry behavior.
- `resolveServiceProvider(name)` resolves one by its manifest name, erroring on
  an unknown value.

## How the rotation engine iterates them

[`rotation.ts`](../src/lib/rotation.ts) `run` resolves the deployment provider
from the registry, then iterates `serviceProviders()` generically:

1. **Detect** which sources are present from the (target-scoped) Vercel env keys.
2. **Guard** — `init` errors if a selected source already exists; a scoped
   `rotate` errors if the named source is absent; an unscoped `rotate` errors if
   nothing is present.
3. **Auth preflight** (`assertProviderAuth`) for exactly the acting sources,
   before any key is minted (#91).
4. **init** each acting source, or **rotate** each and collect its
   `ServiceRotation`; then a single **redeploy** proves the new credentials live.
5. **invalidate** each rotation (or print its retired-key warnings under
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
