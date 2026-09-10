# envctl

A personal, `gh`-style command-line tool for managing deployment configuration and atomically rotating provider secrets across projects and their environments. The hosting/secret providers (Vercel, Firebase, …) sit behind the tool as pluggable backends.

See the [Vision](https://github.com/rmartz/envctl/issues/1) for the design and desired functionality.

## Install

envctl is published to GitHub Packages as `@rmartz/envctl` and installed as a personal global CLI — never a per-project dependency.

**One-time setup.** GitHub Packages requires authentication (even for public packages), so add to your `~/.npmrc`:

```
@rmartz:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<a GitHub token with the read:packages scope>
```

**Install and update:**

```bash
pnpm add -g @rmartz/envctl         # install
pnpm add -g @rmartz/envctl@latest  # update to the newest release
```

Then, from any project directory:

```bash
envctl --version
envctl config push --dry-run   # preview the public-var sync for the current project
envctl env pull                # write .env.local from the development environment
envctl secrets rotate          # atomically rotate Firebase/Sentry secrets and redeploy
envctl secrets init firebase   # bootstrap secrets for a fresh project (auto-detects if omitted)
```

`secrets rotate` mints each new credential, redeploys, then invalidates the old
one, so the project is never left without a working credential. It relies on the
same auth as the rest of the CLI — `VERCEL_TOKEN` or `vercel login`,
`SENTRY_AUTH_TOKEN`, and an authenticated `gcloud` for Firebase key minting (run
`envctl auth status` to check). Pass `--no-invalidate` to keep the old keys or
`--refresh-previews` to redeploy active PR previews afterward. See the
[secrets rotation engine](docs/secrets-rotation.md) for the full mint → deploy →
verify → invalidate flow, and the [docs index](docs/index.md) for the
[config-push](docs/config-push.md) and [environments](docs/env.md) subsystems.

## Bootstrap a blank environment

Bring a linked but otherwise empty Vercel project fully online in one step:

```bash
envctl bootstrap
```

**Prerequisites:**

1. A linked Vercel project (`.vercel/project.json`, created by `vercel link`)
2. An authenticated `gcloud` with a **pre-existing** Firebase project and service account — if the project uses Firebase (envctl mints keys for existing resources; creating the service account from scratch is tracked in [#70](https://github.com/rmartz/envctl/issues/70))
3. A Sentry token (`SENTRY_AUTH_TOKEN` or `sentry-cli login`) and a **pre-existing** Sentry project — if the project uses Sentry

`bootstrap` runs three phases in order: push public variables (`config push`), initialize any missing provider secrets (`secrets init`), and pull a local dotenv file (`env pull`). It is idempotent — safe to re-run after a partial failure, and existing secrets are never rotated. Pass `--dry-run` to preview every phase without making changes.

See the [Bootstrap subsystem docs](docs/bootstrap.md) for the full option reference.

## Development

```bash
pnpm install
pnpm build         # tsc → dist/
pnpm run test:ts   # vitest
```

## Releases

Releases are automated with [semantic-release](https://semantic-release.gitbook.io/): a merge to `main` computes the next version from the Conventional Commit history, tags it, creates a GitHub release, and publishes `@rmartz/envctl` to GitHub Packages.
