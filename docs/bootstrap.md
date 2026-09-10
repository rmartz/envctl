---
type: Subsystem
title: Bootstrap
description: One-command end-to-end setup — push public config, initialize missing secrets, and pull a local dotenv.
resource: src/lib/commands/bootstrap.ts
tags: [bootstrap, onboarding, config, secrets, dotenv, idempotent]
---

# Bootstrap

`envctl bootstrap` configures a project end to end in one pass, so a linked but
otherwise empty Vercel project can be brought fully online without running each
command by hand. It composes the three existing subsystems in order:

1. **Public config** — [config-push](config-push.md): upsert every public
   (non-secret) variable to its Vercel target.
2. **Provider secrets** — the [rotation engine](secrets-rotation.md): initialize
   any configured Firebase / Sentry secret that is **not already present**.
3. **Local dotenv** — [`env pull`](env.md#pulling-config-for-local-testing):
   materialize `.env.local` from the `development` environment.

```bash
envctl bootstrap [OPTIONS]
```

## Idempotency

Bootstrap is safe to re-run, including after a partial failure:

- **config push** upserts — it never deletes, so re-pushing is a no-op for
  unchanged values.
- **secrets** are initialized only when missing. Bootstrap lists the Vercel
  project's env vars once and, for each configured provider whose secret is
  **already present** (`FIREBASE_SERVICE_ACCOUNT` / `FIREBASE_PRIVATE_KEY` for
  Firebase; `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` for Sentry), it **skips**
  initialization rather than erroring. It never rotates an existing secret —
  rotate one explicitly with [`envctl secrets rotate`](secrets-rotation.md).
- **env pull** overwrites the local dotenv from the current remote values.

## Preflight

Before making any change, bootstrap fails fast on missing prerequisites:

- a resolvable Vercel project (a linked `.vercel/project.json`, or
  `VERCEL_PROJECT_ID`) and a Vercel token;
- the **Vercel CLI** on `PATH` (for the pull phase — unless `--no-pull`);
- an authenticated **`gcloud`** when Firebase is configured;
- a **Sentry token** when Sentry is configured.

## Scope note

Bootstrap mints **keys** for resources that already exist — a Firebase project
with its service account, a Sentry project, a linked Vercel project. Creating the
service account and its IAM roles from nothing is tracked separately in
[#70](https://github.com/rmartz/envctl/issues/70). On a project with no prior
deployment, the secrets phase pushes the credential but the verify-by-redeploy
step is skipped until there is something to redeploy (see
[secrets-rotation](secrets-rotation.md)).

## Options

| Flag                      | Effect                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| `--env <name\|all>`       | Environment(s) for the config and secrets phases (default `all`). The pull is always `development`. |
| `--deployment-dir <path>` | Deployment config directory, resolved against the project root (default `deployment`).              |
| `--out <path>`            | Dotenv file the pull phase writes, resolved against the project root (default `.env.local`).        |
| `--no-pull`               | Skip the local dotenv phase.                                                                        |
| `--dry-run`               | Print the plan for every phase without making any changes or Vercel API calls.                      |

## Related

- [config-push](config-push.md), [secrets-rotation](secrets-rotation.md),
  [env](env.md) — the three subsystems bootstrap composes.
