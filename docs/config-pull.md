---
type: Subsystem
title: Config pull
description: Materializes a local dotenv file from an environment for local testing — the inverse of config push.
resource: src/lib/commands/config-pull.ts
tags: [config, environment-variables, vercel, dotenv, local-development]
---

# Config pull

`envctl config pull` materializes a local dotenv file (e.g. `.env.local`) from an
environment, so a project runs locally against that environment's values with one
command. It is the **inverse of [config push](config-push.md)**: push sends
in-repo config up to the provider, pull brings a provider environment down to a
local file.

```bash
envctl config pull [OPTIONS]
```

## What it does

Delegates to the Vercel CLI (`vercel env pull`), which owns decryption and dotenv
escaping. Because it reads back the provider environment, the pulled file
includes the environment's **secrets** (not just public vars) — this is the
"pull existing" strategy that makes a local server actually boot against a real
environment. The environment name maps to its Vercel target the same way as
[config push](config-push.md#environment-mapping) (`development → development`,
`staging`/`preview → preview`, …).

## Safety

The pulled file carries live secrets, so `config pull`:

- **refuses to overwrite** an existing target unless `--force` is given — it never
  clobbers a local file silently;
- writes the file with **owner-only (`0600`) permissions**, so it is never
  world-readable;
- **warns when the target is not gitignored** (checked with `git check-ignore`,
  which honors nested `.gitignore`, negations, and global excludes), since a
  secret-bearing file must never be committed.

## Preflight

Requires the **Vercel CLI** on `PATH` and a linked project
(`.vercel/project.json`, from `vercel link`). The CLI is invoked
non-interactively (`--yes`, `VERCEL_NON_INTERACTIVE=1`) so it never prompts.

## Options

| Flag           | Effect                                                                    |
| -------------- | ------------------------------------------------------------------------- |
| `--env <name>` | Environment to pull, mapped to its Vercel target (default `development`). |
| `--out <path>` | Output file, resolved against the project root (default `.env.local`).    |
| `--force`      | Overwrite the target file if it already exists.                           |

## Deprecated alias: `env pull`

This command previously lived at `envctl env pull`. That spelling still works as a
**deprecated alias** — it prints a deprecation notice and delegates to
`config pull` — but new usage should prefer `config pull`, its natural home
alongside `config push`.

## Related

- [config-push](config-push.md) — the inverse: pushing in-repo public vars up to
  Vercel targets.
- [env](env.md) — defining environments and the config model.
- [secrets-rotation](secrets-rotation.md) — how the secrets this pulls down are
  minted and rotated.
