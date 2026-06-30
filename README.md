# envctl

A personal, `gh`-style command-line tool for managing deployment configuration and atomically rotating provider secrets across projects and their environments. The hosting/secret providers (Vercel, Firebase, …) sit behind the tool as pluggable backends.

See the [Vision](https://github.com/rmartz/envctl/issues/1) for the design and desired functionality.

> **Status:** early bootstrap. The provider engine (Vercel API client, Firebase/GCP key rotation, Sentry, deployments) has been ported from its predecessor (`rmartz/vercel-deploy-scripts`); the `envctl` CLI surface, in-repo config detection, and global-install packaging are tracked in the [envctl v1](https://github.com/rmartz/envctl/milestone/1) milestone.

## Development

```bash
pnpm install
pnpm build         # tsc → dist/
pnpm run test:ts   # vitest
```

## Install

envctl is installed as a personal global CLI — not a per-project dependency and not published to a public registry.

```bash
./install.sh
```

This builds the project and symlinks the `envctl` entrypoint into `~/.local/bin`. Override the location with `PREFIX`:

```bash
PREFIX=/usr/local/bin ./install.sh
```

The script is re-runnable — run it again any time to rebuild and refresh the symlink. Make sure the install directory is on your `PATH` (the script warns if it isn't).

Then, from any project directory:

```bash
envctl --version
envctl config push --dry-run   # preview the public-var sync for the current project
```

A personal Homebrew tap is a later milestone.
