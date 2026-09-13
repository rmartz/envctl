---
type: Runbook
title: Applying config and minting/rotating secrets on a Vercel deploy
description: The scenario-driven playbook for using envctl to push config and mint/rotate Firebase & Sentry secrets on a Firebase + Next.js Vercel project.
resource: src/lib/rotation.ts
tags: [runbook, vercel, firebase, sentry, secrets, config-push, agent]
---

# Runbook — applying config and minting/rotating secrets on a Vercel deploy

The task-oriented playbook for operating envctl against a **Firebase + Next.js**
project deployed on **Vercel**. It tells you **when** to reach for each command,
**in what order**, **what must be true first**, and **how to confirm it worked**.

For _mechanism_ detail — how each command works internally — this runbook links
into the subsystem docs rather than repeating them: the deployment-config model
and auth ([env](env.md)), public-var syncing ([config-push](config-push.md)),
and the atomic mint→deploy→verify→invalidate engine
([secrets-rotation](secrets-rotation.md)). Read this page to decide _what to do_;
follow the links to understand _how it happens_.

> This runbook replaces the retired predecessor guidance (the `sync-env` skill
> pointing at `vercel-deploy-scripts`). That library is no longer available; use
> envctl and this page instead.

## Orientation & mental model

- **envctl is a global, `gh`-style CLI**, installed once per machine and pointed
  at a project by its **working directory**. Every command takes the global
  `-C, --working-dir <dir>` flag (default: current directory) to select the
  project root it operates on.
- **Config-as-code lives in the project's own repo**, under a `deployment/`
  directory — version-controlled and reviewable, never a central store. See the
  [deployment-config model](env.md#deployment-configuration-model).
- **Public vars and secrets are separate concerns.** Public (non-secret)
  environment variables are pushed with `config push`; private credentials
  (Firebase service-account keys, the Sentry auth token) are minted and rotated
  with `secrets init` / `secrets rotate`. The two never overlap — pushing config
  does not touch secrets, and rotating secrets does not touch public vars.

## Preconditions — check these first, fail fast

Run these before any scenario below. A run that skips them fails deeper in, with
a less obvious message.

1. **A linked Vercel project.** The project must contain
   `.vercel/project.json` (created by `vercel link`). `config push`, `env pull`,
   and secrets flows all require it.
2. **Auth for each provider in play.** Run **`envctl auth status` first** — it
   reports `vercel`, `gcp`, and `sentry`, each as authenticated (with its source)
   or not (with a hint):

   ```bash
   envctl -C <project-dir> auth status
   ```

   - **Vercel** — `VERCEL_TOKEN`, else a `vercel login` session.
   - **Sentry** — `SENTRY_AUTH_TOKEN`, else a `sentry-cli login` session. Sentry
     flows also need `SENTRY_ORG` / `SENTRY_PROJECT` (from the deployment YAML or
     the shell).
   - **Firebase** — an authenticated **`gcloud`** (`gcloud auth login`); envctl
     mints keys through `gcloud iam service-accounts keys create`.

   See [auth resolution](env.md#authentication) for exactly where each token is
   read from.

3. **Firebase service-account precondition.** For any Firebase flow, the
   GCP/Firebase **project and the service account** (`FIREBASE_SA_EMAIL`) must
   **already exist**. envctl mints **keys** for an existing service account — it
   does **not** yet create the SA or bind its IAM roles. A "truly blank, no SA"
   project is **not** supported here; that provisioning is tracked in
   [#70](https://github.com/rmartz/envctl/issues/70). Do not mistake the
   cold-start scenario (A) for SA creation.

> **Verification depth — read before trusting a rotation.** Today, "proven
> working" means the **redeploy reached Vercel `READY`**, not that the credential
> itself authenticated against Firebase/Sentry. Whether `READY` sufficiently
> proves the credential is an open question tracked in
> [#74](https://github.com/rmartz/envctl/issues/74). Do not over-trust a green
> rotation: a `READY` deploy with a subtly bad key will still report success.

## The `deployment/` config model at a glance

Full detail in [env](env.md#deployment-configuration-model); the essentials an
operator needs:

- **`deployment/environments.yml`** — an `active:` list of deploy-environment
  names.
- **`deployment/{env}.yml`** — one file per environment. The **nested**
  `environment:` / `variables:` form is **canonical** (a flat map is also
  accepted):

  ```yaml
  environment: staging
  variables:
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: my-project-staging
    SENTRY_ORG: my-org
    SENTRY_PROJECT: my-app
  ```

- **Name → Vercel target** mapping is by convention: `production → production`,
  `staging`/`preview → preview`, `development → development`, anything else
  passed through as-is.
- **The `development` target is implicit** — it never appears in
  `environments.yml` and has no file of its own. It **mirrors the staging/preview
  source** (the first active env whose target is `preview`): config-push
  populates it from that source's public vars, and the rotation engine gives it
  its **own** Firebase key against the shared staging project.

## Command surface at a glance

| Command                                                      | Purpose                                                   | Key flags                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------- |
| `init`                                                       | Scaffold `deployment/` (seeds `production`)               | —                                                                    |
| `env add <name> --target <production\|preview\|development>` | Add an environment                                        | `--target`                                                           |
| `env list`                                                   | List environments and resolved targets                    | —                                                                    |
| `config push`                                                | Upsert public vars to Vercel                              | `--env`, `--deployment-dir`, `--dry-run`                             |
| `secrets init [firebase\|sentry]`                            | Mint secrets for a fresh project (auto-detect if omitted) | `--env`, `--deployment-dir`, `--no-invalidate`, `--refresh-previews` |
| `secrets rotate`                                             | Rotate existing secrets, redeploy, invalidate             | `--env`, `--deployment-dir`, `--no-invalidate`, `--refresh-previews` |
| `env pull`                                                   | Materialize a local dotenv from a Vercel env              | `--env`, `--out`                                                     |
| `auth status`                                                | Report provider auth (vercel / gcp / sentry)              | —                                                                    |

Shared flags: **`--env <name|development|all>`** selects the deploy
environment(s) (default `all` for push/secrets); **`--deployment-dir <path>`**
overrides the config directory (default `deployment`); **`--no-invalidate`**
keeps old secrets after a rotation; **`--refresh-previews`** redeploys warm PR
previews after a rotation. Every command also takes the global
`-C/--working-dir`.

> `-C <project-dir>` is omitted from the per-command lines in the scenarios below
> for brevity — run each command from the project root, or prepend
> `-C <project-dir>` to operate from elsewhere.

---

## Scenarios

Each scenario is a copy-pasteable sequence with a "**how you know it worked**"
check. Confirm the [preconditions](#preconditions--check-these-first-fail-fast)
first.

### A. Cold-start — fully apply config to a blank (but linked) Vercel project

The project is linked (`.vercel/project.json` exists) but has no config pushed
and no secrets yet. Apply everything in order:

```bash
envctl init                       # scaffold deployment/ (seeds a production env)
# → edit deployment/environments.yml and deployment/*.yml to declare your
#   environments and their public vars (NEXT_PUBLIC_*, SENTRY_ORG/PROJECT, …)
envctl config push --dry-run      # preview the plan — no Vercel calls
envctl config push                # upsert the public vars to every target
envctl secrets init               # auto-detect providers and mint their secrets
envctl env pull                   # write .env.local from the development env
```

**How you know it worked:**

- `config push --dry-run` prints the per-target create/update plan; the real
  `config push` reports each variable upserted.
- `secrets init` reports each provider initialized. **On a project with no prior
  deployment, post-mint verification is skipped** — there is nothing to
  redeploy, so envctl warns rather than deploying; the pushed vars and minted
  keys are consumed by the **first real Vercel build**. This is expected on a
  cold start, not a failure.
- `env pull` writes `.env.local` containing the development environment's vars.

> A future single-command path for this whole sequence (a blank-env bootstrap
> orchestrator) is tracked in
> [#71](https://github.com/rmartz/envctl/issues/71). Until it lands, run the
> steps above in order.

### B. Mint secrets for an initial deploy

Public vars are already pushed; now mint the private credentials. `secrets init`
**auto-detects** which providers to initialize from the public vars in your
deployment config, or you can name one explicitly:

```bash
envctl secrets init                 # auto-detect firebase and/or sentry
envctl secrets init firebase        # Firebase only
envctl secrets init sentry          # Sentry only
```

**Per-provider scoping matters** (see
[per-environment behavior](secrets-rotation.md#per-environment-behavior-of-init---env-all)):

- **Sentry** is initialized **once, project-wide**, from a single environment.
- **Firebase** is initialized **per Vercel target** — each gets its own key, and
  the implicit `development` target receives its **own** key against the shared
  staging project.

**How you know it worked:** `secrets init` reports each provider/target
initialized. `init` refuses to run if the secret **already exists** — that guard
means you should be **rotating**, not initializing (see the
[rotate-vs-init note](#rotate-vs-init--picking-the-right-verb)). As in scenario
A, verification is skipped when there is no prior deployment to redeploy.

### C. Rotate keys — routine or emergency

Rotation is **atomic**: mint the new credential → push it → redeploy and wait for
Vercel `READY` → invalidate the old one. The project is never left without a
deployed key; whether the new key successfully authenticates is subject to the
[verification-depth caveat](#gotchas--caveats). Full flow in
[the atomic flow](secrets-rotation.md#the-atomic-flow).

```bash
envctl secrets rotate                       # rotate all providers, all targets
envctl secrets rotate --env production      # rotate a single target only
envctl secrets rotate --no-invalidate       # staged rollout: keep the old keys
envctl secrets rotate --refresh-previews    # also redeploy warm PR previews
```

- **`--env production`** scopes the rotation to one target (e.g. an emergency
  production-only rotation).
- **`--no-invalidate`** keeps the old keys live after the redeploy and **prints
  their ids** so you can retire them by hand once the new key is confirmed —
  useful for a staged rollout.
- **`--refresh-previews`** redeploys active PR previews so their warm instances
  pick up the new credential.

**How you know it worked:** each target's redeploy reaches Vercel `READY` and,
unless `--no-invalidate`, the old key is deleted (with `--no-invalidate`, the old
key ids are printed for manual cleanup). **Remember the
[verification-depth caveat](#gotchas--caveats):** `READY`
proves the deploy succeeded, not that the new credential authenticates
([#74](https://github.com/rmartz/envctl/issues/74)).

### D. Add a provider to an existing project

The project already deploys with, say, Firebase, and you want to add Sentry.
Introduce the provider's public vars first, push them, then mint its secret:

```bash
# 1. Add the provider's detection keys to deployment/*.yml, e.g. for Sentry:
#      SENTRY_ORG: my-org
#      SENTRY_PROJECT: my-app
envctl config push --dry-run        # confirm the new keys appear in the plan
envctl config push                  # upsert them to Vercel
envctl secrets init sentry          # now mint the new provider's secret
```

**How you know it worked:** `config push` reports the new public keys created,
and `secrets init sentry` reports Sentry initialized. Naming the provider
explicitly (`sentry`) avoids re-touching the already-established Firebase secret.

### E. Change public vars only

No secret change — just add, update, or correct public (non-secret) vars. Edit
the YAML and push. **`config push` is upsert-only and never deletes** (see the
[gotcha](#gotchas--caveats)), so removing a key from YAML leaves the remote value
in place.

```bash
# Edit deployment/{env}.yml, then:
envctl config push --dry-run                # always preview first
envctl config push                          # push all environments
envctl config push --env production         # or a single environment
```

**How you know it worked:** `--dry-run` shows exactly which keys will be created
vs. updated per target; the real run reports each upsert. No redeploy is
triggered — `config push` does not deploy (Vercel applies the vars on the next
build).

### F. Pull config for local development

Materialize a local dotenv from a Vercel environment for local testing.
`env pull` wraps `vercel env pull`, which owns decryption and dotenv escaping.

```bash
envctl env pull                             # writes .env.local from development
envctl env pull --env staging --out .env    # a different env / output path
```

**How you know it worked:** the target dotenv file (`.env.local` by default)
exists and contains the environment's variables. Requires the Vercel CLI on
`PATH` and a linked project; it runs non-interactively and never prompts.

---

## Rotate vs. init — picking the right verb

`init` and `rotate` share one engine but **detect** and **act** differently — and
choosing the wrong verb produces a guard error, not silent damage:

|                       | **init**                                 | **rotate**                             |
| --------------------- | ---------------------------------------- | -------------------------------------- |
| Detects services from | public vars in the **deployment config** | keys **already in** the Vercel project |
| Precondition          | the secret does **not** exist            | the secret **exists**                  |
| Old key               | none to invalidate                       | invalidated after the redeploy         |

- Use **`init`** when standing up a provider's secret for the **first time** (no
  key in Vercel yet).
- Use **`rotate`** when a working key **already exists** and you want to replace
  it.
- If you pick wrong, envctl **refuses with a guard error** — `init` errors when
  the key already exists (rotate instead); `rotate` finds nothing to rotate when
  the key is absent (init instead). Re-run with the other verb.

Full comparison: [rotate vs. init](secrets-rotation.md#rotate-vs-init).

## Gotchas & caveats

- **`config push` is upsert-only and never deletes.** A var removed from YAML is
  **not** removed from Vercel — untracked remote vars are left untouched. Prune
  those manually if you need them gone.
- **Verification depth.** "Proven working" means the redeploy reached Vercel
  `READY`, **not** that the credential authenticated
  ([#74](https://github.com/rmartz/envctl/issues/74)). Don't over-trust a green
  rotation.
- **Firebase service-account precondition.** envctl mints **keys** for an
  existing service account; it does **not** create the SA or bind IAM roles
  ([#70](https://github.com/rmartz/envctl/issues/70)). A blank project with no SA
  is not yet supported.
- **First-deploy verification is skipped.** With no prior deployment, there is
  nothing to redeploy, so post-push/mint verification does not run — the first
  real Vercel build consumes the pushed vars and minted keys.
- **Wrong-verb guard errors** differ by detection signal (existing Vercel keys
  for `rotate` vs. deployment-config public vars for `init`) — see
  [rotate vs. init](#rotate-vs-init--picking-the-right-verb) above.

## Related

- [env](env.md) — the deployment-config model, `init`/`env add`/`env list`,
  `env pull`, and auth resolution.
- [config-push](config-push.md) — the public-var upsert mechanism.
- [secrets-rotation](secrets-rotation.md) — the atomic mint→deploy→verify→
  invalidate engine behind `secrets init` / `secrets rotate`.
- [Vision](https://github.com/rmartz/envctl/issues/1) — desired-functionality
  items 3–5, which this runbook operationalizes.
