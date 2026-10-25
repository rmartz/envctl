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
builds on. **`secrets` now reads the manifest** to resolve the Firebase
[credential contract](secrets-rotation.md#firebase-credential-contract) (its field→var-name map). The legacy config path ([env.md](env.md)) is still what
`config push` and `env pull` run on today.

## The model

`manifest.yml` declares structure once; per-environment overlay files
(`deployment/{env}.yml`) carry only literal value overrides.

```yaml
# deployment/manifest.yml
environments: [production, staging, qa]

deployments: # provider-typed sinks
  - provider: vercel
    projectId: prj_abc123 # optional pin; otherwise the link / VERCEL_* vars
    teamId: team_xyz789 # optional
    targets: { production: production, staging: preview, qa: preview }

services: # provider-typed sources of secret vars + rotation
  - provider: firebase
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

github: # mirror pushed values to GitHub Actions secrets (#198)
  repo: acme/app # optional; default: the working directory's repo
  secrets:
    - variable: CRON_SECRET
      environment: production
    - variable: FB_PRIVATE_KEY
      environment: staging
      name: STAGING_FB_PRIVATE_KEY # optional; default: the variable name
      githubEnvironment: e2e # optional; default: a repository secret
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
  `environments`, `deployments` (each with its explicit env→target map and an
  optional `projectId`/`teamId`
  [project pin](env.md#pinning-the-vercel-project)),
  `services` (with an optional `environments` scope, and — for `firebase` — an
  optional field→var-name `variables` map that forms the
  [credential contract](secrets-rotation.md#firebase-credential-contract), and
  — for `github-app` — a `webhookUrl`; see
  [GitHub App](secrets-rotation.md#github-app)),
  `variables` and `variableGroups` (each variable carrying its `source`
  discriminant), plus the per-env `overlays` read from `deployment/{env}.yml`.
  An optional `github` block declares the
  [GitHub Actions secrets](secrets-rotation.md#github-actions-secrets) that
  pushed values are mirrored to. Entries missing `variable` or `environment`
  are dropped.
- **Legacy back-compat** — with no `manifest.yml`, the legacy `environments.yml`
  (`active:` list) and flat per-env value files map onto the same model: each env
  defaulted through `vercelTarget()` under a single implicit `vercel` deployment,
  and every per-env var treated as a literal `value` overlay. A project with no
  config at all degrades to an empty model.

Field parsing lives in [`parse-fields.ts`](../src/lib/manifest/parse-fields.ts);
`parse.ts` assembles the model and reads the overlays.

## Named deployments and services

The foundation of epic [#210](https://github.com/rmartz/envctl/issues/210)
(#211). Every service and deployment has a `name`, which defaults to its
`provider`. Two instances of the same provider therefore need explicit names. A
deployment can also narrow what reaches it:

```yaml
services:
  - provider: sentry # name: sentry
  - name: gate-app
    provider: github-app
deployments:
  - name: gate
    provider: vercel
    services: [gate-app, sentry] # absent ⇒ every service
    environments: [production] # absent ⇒ every declared environment
    variables: # only this deployment; same syntax as top-level
      PR_APP_ROLE: { value: gate }
    targets: { production: production }
```

[`manifestErrors(manifest)`](../src/lib/manifest/deployments.ts) is a pure
function that returns the structural errors `check` reports:

- duplicate service names;
- duplicate deployment names;
- a deployment referencing an undefined service;
- a deployment scoped to an undeclared environment.

**Commands act on one deployment.**
[`soleDeployment`](../src/lib/manifest/deployments.ts) returns it, and it is
what `config push`, `config pull`, `secrets`, `bootstrap`, `env add` and
env→target resolution use. Run against the root of a manifest that declares
several deployments, it **refuses** and names them, rather than silently acting
on the first, which could send one project's secrets to another. Select one with
`--deployment <name>`, which resolves to its view.

### Deployment views

`<deployment-dir>/<name>/` with no `manifest.yml` or `environments.yml` of its
own is a **view** of the parent manifest's deployment `<name>` (#213, resolved
by [`view.ts`](../src/lib/manifest/view.ts)). The directory doesn't have to
exist. `parseManifest`, `listActiveEnvs` and `parseDeploymentEnv` all resolve
it, so every command works on it unchanged:

| In the view  | Comes from                                                                     |
| ------------ | ------------------------------------------------------------------------------ |
| environments | the deployment's `environments`, else the root's                               |
| deployments  | just this one, with its project pin                                            |
| services     | only those the deployment lists (all of them if it lists none)                 |
| variables    | top-level plus the deployment's own, the deployment's winning on a name clash  |
| overlays     | `<deployment-dir>/{env}.yml`, then `<deployment-dir>/<name>/{env}.yml` over it |

`--deployment <name>`, on `config push`, `config pull`, `secrets` and
`bootstrap`, is sugar for `--deployment-dir <deployment-dir>/<name>`. An
unknown name errors, listing the declared ones. A repo can therefore fold
per-project directories into one root manifest and keep its existing
`--deployment-dir deployment/<name>` command lines.

A view's guarantees:

- **Invalid roots are refused.** If the root has any `manifestErrors`, the
  view isn't resolved, since a dangling reference would otherwise silently drop
  a service from it.
- **Shared roots need pins.** When the root declares more than one deployment,
  each must pin its project (`projectId`, `teamId`). Otherwise they would all
  fall back to the same `.vercel` link or `VERCEL_PROJECT_ID`.
- **Services stay where they're listed.** A deployment that lists `services`
  gets only those. `secrets init` doesn't auto-detect an unlisted Firebase or
  Sentry from public vars in a shared overlay, and naming one explicitly
  (`secrets init sentry`) is refused.

`check` validates each deployment's env→target resolution and project identity
through its view, prefixing findings with the deployment name.

### Service routing

A service **reaches** a deployment that lists it, or every deployment if that
deployment lists none ([`routing.ts`](../src/lib/manifest/routing.ts), #215):

- **One per provider.** The rotation engine keys services by provider, so a
  deployment receiving two services of one provider (two `github-app`s, say) is
  a `manifestErrors` error.
- **No shared variable names.** Two services of different providers writing
  the same variable on one deployment are a `check` error (`serviceVarCollisions`
  in [`service-vars.ts`](../src/lib/service-vars.ts)).
- **No foreign variables live.** `check --live` reconciles each deployment of a
  multi-deployment root through its view. It reports an error for any
  variable on that project owned only by a service the deployment doesn't
  list, such as the other App's private key.
- **Secrets commands route by service.** They select the deployment through the
  service, act on a shared service across all its deployments at once, and
  refuse to rotate a shared one under a single deployment; see
  [shared services](secrets-rotation.md#shared-services-across-deployments).

- **Generated variables follow their declaration.** A `generate: true`
  variable declared at the root (top level or a root group) has one value
  across every deployment. One declared under a deployment stays its own; see
  [shared generated secrets](secrets-rotation.md#shared-across-deployments).

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
