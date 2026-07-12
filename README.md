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
```

## Development

```bash
pnpm install
pnpm build         # tsc → dist/
pnpm run test:ts   # vitest
```

## Releases

Releases are automated with [semantic-release](https://semantic-release.gitbook.io/): a merge to `main` computes the next version from the Conventional Commit history, tags it, creates a GitHub release, and publishes `@rmartz/envctl` to GitHub Packages.
