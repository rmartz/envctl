---
type: Script
title: check-release-age
description: Fails a PR that introduces a lockfile package version younger than the cooldown window.
resource: scripts/check-release-age.mjs
tags: [ci, dependencies, supply-chain, dependabot]
---

# check-release-age

A deterministic **dependency release-age gate**. It fails a pull request that
introduces a package version younger than `RELEASE_AGE_MIN_DAYS` (default `7`),
enforcing the "let a release age before we adopt it" supply-chain policy at a
layer we control.

## Why it exists

envctl already configures a 7-day `cooldown` in
[`.github/dependabot.yml`](../.github/dependabot.yml). That cooldown is
**advisory at PR-creation time** and has documented reliability gaps for the npm
ecosystem ([dependabot-core#12677](https://github.com/dependabot/dependabot-core/issues/12677)):
versions can slip through the window — for example several same-day patch bumps
merging while each is only days old. This gate is the **second layer** that
catches those escapes deterministically, on every PR.

A young release is the highest-risk window for a compromised or hijacked
package: malicious versions are typically discovered and yanked within days, so
simply waiting out the cooldown avoids most of the blast radius.

## How it works

1. Reads the head `pnpm-lock.yaml` from the working tree and the base lockfile
   via `git show <baseRef>:pnpm-lock.yaml`.
2. Parses the top-level `packages:` block of each (pnpm v9 lockfile format),
   whose keys are canonical `name@version` pairs, and computes the set of
   versions **present in head but not base** — the newly-introduced ones. This
   diffs the _lockfile_, not just `package.json`, so fresh **transitive** bumps
   are caught too.
3. Queries `registry.npmjs.org` for each introduced version's publish date and
   fails, listing any younger than the threshold.

### Why the lockfile diff, not pnpm's `minimum-release-age`

Setting pnpm's `minimum-release-age` in committed config makes Dependabot's own
lockfile regeneration honor it, forcing pnpm to fetch publish-time metadata for
the whole candidate tree on every update — a full-metadata storm that causes
multi-minute Dependabot timeouts. This gate never touches Dependabot's resolver:
it inspects the _result_ and queries only the handful of changed versions.

### Fail-open on registry errors

A registry fetch failure is **warned and skipped**, so a flaky registry does not
produce a spurious red build. Private / workspace / tarball specifiers that do
not resolve on the public registry are skipped as well. A _confirmed_ too-young
version always fails the build.

## Usage

```bash
node scripts/check-release-age.mjs [baseRef]   # baseRef defaults to origin/main
pnpm run check:release-age                      # same, via the package script
RELEASE_AGE_MIN_DAYS=14 pnpm run check:release-age   # override the window
```

## CI wiring

[`.github/workflows/release-age.yml`](../.github/workflows/release-age.yml) runs
it on `pull_request` events that change `pnpm-lock.yaml` (or the checker itself).
It is **pull_request-only** by design — the gate exists to stop a hot version
from _landing_; running on push-to-`main` would only fail an already-merged
commit. The job checks out full history (`fetch-depth: 0`) so the base lockfile
is readable, and runs Node directly with no dependency install.

## Follow-ups

- Make it a **required** status check in branch protection so it blocks merge,
  not just reports.
- The coordinator should **re-run** the check (rather than close the PR) once a
  held version ages past the window, so the PR flips green and flows normally.
