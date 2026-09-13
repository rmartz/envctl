---
type: Subsystem
title: Deployment manifest schema
description: The typed manifest.yml model, its parser (with legacy back-compat), and the comment-preserving writer that the config-manifest epic builds on.
resource: src/lib/manifest/parse.ts
tags: [manifest, config, schema, parser, provider-agnostic]
---

# Deployment manifest schema

The typed foundation for envctl's config-manifest epic
([#84](https://github.com/rmartz/envctl/issues/84)): a single
`deployment/manifest.yml` that declares a project's **structure, sources, and
scopes** env-agnostically, parsed into one resolved model the rest of the epic
builds on. **This is a foundation only — no command reads the manifest yet.**
The legacy config path ([env.md](env.md)) is still what `config push`, `env
pull`, and the [secrets engine](secrets-rotation.md) run on today.

## The model

`manifest.yml` declares structure once; per-environment overlay files
(`deployment/{env}.yml`) carry only literal value overrides.

```yaml
# deployment/manifest.yml
environments: [production, staging, qa]

deployments: # provider-typed sinks; identity is still discovered per-provider
  - provider: vercel
    targets: { production: production, staging: preview, qa: preview }

services: # provider-typed sources of secret vars + rotation
  - provider: firebase
    credential: split # firebase credential shape: split | json (#97)
    variables: # map each field → the exact var name the app reads (#98)
      privateKey: FB_PRIVATE_KEY
  - provider: action-tracking
    environments: [production] # env-scoped: prod-only service

variables: # project-owned, ungrouped ⇒ every environment
  NEXT_PUBLIC_SITE_NAME: { value: "Hidden Role Game" } # literal ⇒ public
  CRON_SECRET: { generate: true } # generated ⇒ secret

variableGroups:
  - name: prod-analytics
    environments: [production]
    variables:
      ANALYTICS_WRITE_KEY: { generate: true }
```

```yaml
# deployment/production.yml — overlay: ONLY literal value overrides for this env
NEXT_PUBLIC_API_URL: https://api.example.com
```

### Source-of-value taxonomy

Every variable is _declared_; what differs is where its value comes from — its
**source**. Visibility is **derived** from the source, never a separate flag:

| Source            | In git? | Visibility | Model                      |
| ----------------- | ------- | ---------- | -------------------------- |
| `value` (literal) | yes     | public     | `{ kind: "value", value }` |
| `generate`        | no      | secret     | `{ kind: "generate" }`     |

`variableVisibility(source)` returns `"public"` for a literal `value` and
`"secret"` for anything else.

## Parser

[`parseManifest(deploymentDir)`](../src/lib/manifest/parse.ts) returns the
resolved model:

- **New format** — when `deployment/manifest.yml` exists, it is parsed into
  `environments`, `deployments` (each with its explicit env→target map),
  `services` (with an optional `environments` scope, and — for `firebase` — an
  optional `credential` shape and field→var-name `variables` map that form the
  [credential contract](secrets-rotation.md#firebase-credential-contract)),
  `variables` and `variableGroups` (each variable carrying its `source`
  discriminant), plus the per-env `overlays` read from `deployment/{env}.yml`.
- **Legacy back-compat** — with no `manifest.yml`, the legacy `environments.yml`
  (`active:` list) and flat per-env value files map onto the same model: each env
  defaulted through `vercelTarget()` under a single implicit `vercel` deployment,
  and every per-env var treated as a literal `value` overlay. A project with no
  config at all degrades to an empty model.

[`effectiveValue(manifest, env, name)`](../src/lib/manifest/resolve.ts) resolves
a variable's literal value for an environment: a per-env overlay override wins
over the declared base `value`; a non-literal source (e.g. `generate`) resolves
to `undefined` (it carries no value in git).

## Writer

[`setManifestEnvironments(deploymentDir, environments)`](../src/lib/manifest/write.ts)
updates the `environments:` list using the `yaml` **Document API**, so comments
and key ordering in a hand-edited `manifest.yml` are **preserved** across the
write. This is the comment-safe replacement for the legacy `writeActiveEnvs()`
js-yaml `load → mutate → dump` round-trip, which discards them.

## Related

- [Environments and local config](env.md) — the legacy config model still in
  force for commands today.
- Epic [#84](https://github.com/rmartz/envctl/issues/84); schema issue
  [#85](https://github.com/rmartz/envctl/issues/85).
