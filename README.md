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

## Distribution

envctl is installed as a personal global CLI — not a per-project dependency and not published to a public registry. An install script (and later a personal Homebrew tap) will land with the v1 milestone.
