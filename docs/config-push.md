---
type: Subsystem
title: Config push
description: Upserts public (non-secret) environment variables from in-repo YAML to a Vercel project.
resource: src/lib/commands/config-push.ts
tags: [config, environment-variables, vercel, public-vars]
---

# Config push

`envctl config push` syncs a project's **public** (non-secret) environment
variables from its in-repo deployment configuration to the matching Vercel
targets. Secrets are handled separately by the
[rotation engine](secrets-rotation.md).

```bash
envctl config push [OPTIONS]
```

## What it does

Reads the active environments from `<deployment-dir>/environments.yml` and each
environment's values from `<deployment-dir>/{env}.yml` (see the
[deployment-config model](env.md#deployment-configuration-model)), then, for
each resolved Vercel target, **upserts** every variable:

- an existing variable is **updated in place** (`updateEnvVar`, PATCH);
- a missing one is **created** as a `plain`-type record (`createEnvVar`, POST);
- a variable **not** present in the config files is left **untouched** — push
  never deletes.

Because it upserts and never deletes, `config push` is safe to run against a
blank Vercel project (everything is created) or an established one (only the
tracked keys change).

## Environment mapping

The deploy-environment name maps to a Vercel target by convention
(`vercelTarget`):

| Deploy environment | Vercel target            |
| ------------------ | ------------------------ |
| `production`       | `production`             |
| `staging`          | `preview`                |
| `preview`          | `preview`                |
| `development`      | `development` (implicit) |
| _other_            | passed through as-is     |

The `development` target is always populated from the **same YAML source** as
the `staging`/`preview` environment. It has no entry in `environments.yml` and
no dedicated YAML file of its own.

## Options

| Flag                             | Effect                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `--env <name\|development\|all>` | Push one named environment, the implicit `development` target, or all of them (default `all` — every active env plus `development`). |
| `--deployment-dir <path>`        | Deployment config directory, resolved against the project root (default `deployment`).                                               |
| `--dry-run`                      | Print the intended plan (which keys would be created/updated per target) without making any Vercel API calls.                        |

Always preview with `--dry-run` first when pushing to an unfamiliar project.

## Related

- [env](env.md) — defining environments and the config model this reads.
- [secrets-rotation](secrets-rotation.md) — the secret counterpart to public
  vars.
