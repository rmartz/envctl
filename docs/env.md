---
type: Subsystem
title: Environments and local config
description: The in-repo deployment-config model, defining environments, and auth resolution.
resource: src/lib/commands/env.ts
tags: [environments, config, dotenv, vercel, local-development]
---

# Environments and local config

envctl's config-as-code foundation: how a project **declares** its deploy
environments in its own source tree. Both [config-push](config-push.md) and the
[secrets rotation engine](secrets-rotation.md) read the model described here, and
[config-pull](config-pull.md) materializes any of these environments into a local
dotenv for testing.

## Deployment configuration model

A project's configuration lives under a `deployment/` directory in its own
repository — version-controlled and reviewable, never a central store.

- **`deployment/environments.yml`** — an `active:` list of the deploy
  environment names.

  ```yaml
  active:
    - production
    - staging
  ```

- **`deployment/{env}.yml`** — one file per environment, holding its public
  variables. The **nested** form (what `init`/`env add` scaffold) is canonical;
  a flat map is also accepted.

  ```yaml
  environment: staging
  variables:
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: my-project-staging
    SENTRY_ORG: my-org
  ```

Parsing lives in [`environments.ts`](../src/lib/environments.ts)
(`listActiveEnvs`, `parseDeploymentEnv`). A blank file degrades to an empty
result rather than throwing.

> **Foundation in progress.** A richer, single-file
> [deployment manifest](manifest.md) (`manifest.yml`) — declaring deployments,
> services, and variable sources/scopes in one place — has landed as a typed
> schema + parser. It is not yet wired into any command; the flat model
> described here is still what `config push`, `env pull`, and the rotation
> engine run on today.

### Name → target mapping

Each deploy-environment name maps to a Vercel infrastructure target by
convention (`vercelTarget`): `production → production`, `staging`/`preview →
preview`, `development → development`, anything else passed through as-is.

The **`development`** target is implicit — it never appears in
`environments.yml` and has no file of its own. It mirrors the **staging/preview
source**: the first active environment whose target is `preview` (`findDevSource`
in [env-plan.ts](../src/lib/commands/env-plan.ts)). config-push populates it from
that source's public vars; the rotation engine gives it its own Firebase key
against the shared staging project.

Because config files are reserialized with `js-yaml` (`load → mutate → dump`),
comments and key ordering in a hand-edited file are **not** preserved across an
`env add`.

## Defining environments

```bash
envctl init                                   # scaffold deployment/ with a sample production env
envctl env add <name> --target <production|preview|development>
envctl env list                               # list environments and their targets
```

- **`init`** ([init.ts](../src/lib/commands/init.ts)) creates
  `deployment/environments.yml` (seeded with `production`) and a sample env
  file. It is a no-op with a warning if config already exists — it never
  clobbers hand-edited files.
- **`env add`** appends the name to the active list and scaffolds its file.
  Idempotent: an already-active name is a no-op. `--target` declares the intended
  mapping and is validated against the allowed set (`production|preview|development`);
  if it disagrees with the name convention, `env add` warns (config push maps by
  name). The target is not persisted — `environments.yml` stores only the env name.
- **`env list`** prints each active environment and its resolved Vercel target.

## Pulling config for local testing

Materializing a local dotenv for local testing is the inverse of pushing config,
so it lives with [config push](config-push.md) as **[`config pull`](config-pull.md)**
(`envctl config pull`). The former `envctl env pull` spelling still works as a
deprecated alias.

## Authentication

Credential resolution lives in [`auth.ts`](../src/lib/auth.ts) and is surfaced
read-only by `envctl auth status`:

- **Vercel** (`resolveVercelToken`): `VERCEL_TOKEN`, else the token stored by
  `vercel login` (the platform-specific `com.vercel.cli/auth.json`, honoring its
  expiry).
- **Sentry** (`resolveSentryToken`): `SENTRY_AUTH_TOKEN`, else the `token =`
  value from `sentry-cli`'s `~/.sentryclirc`.

`auth status` reports whether each provider resolves and its human-readable
source; it never prints the token value.

## Related

- [config-push](config-push.md) — pushing these environments' public vars to
  Vercel.
- [config-pull](config-pull.md) — materializing an environment into a local
  dotenv for testing.
- [secrets-rotation](secrets-rotation.md) — minting and rotating the private
  credentials.
