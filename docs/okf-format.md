---
type: Subsystem
title: OKF documentation format
description: What Google's Open Knowledge Format is, how envctl's docs/ bundle uses it, and where the authoritative spec lives.
tags: [documentation, okf, reference, convention]
---

# OKF documentation format

envctl's `docs/` directory is an **Open Knowledge Format (OKF)** bundle. OKF is
a vendor-neutral standard from Google Cloud for expressing curated knowledge as
plain Markdown files with YAML frontmatter, so the same reference material can be
consumed by people, tools, and AI agents without a proprietary format.

## Authoritative reference

**The [OKF specification (`GoogleCloudPlatform/knowledge-catalog/okf/SPEC.md`)](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
is the single source of truth for the format.** This page summarizes how envctl
applies OKF; for any question about what the format itself permits or requires —
frontmatter fields, versioning, link semantics, index behavior — defer to the
spec, not to this page. Where this page and the spec disagree, the spec wins.

## Frontmatter

Every OKF document opens with a YAML frontmatter block. The spec reserves a small
set of structured fields:

| Field         | Required | Purpose                                                     |
| ------------- | -------- | ----------------------------------------------------------- |
| `type`        | **yes**  | The kind of document (e.g. `Script`, `Subsystem`, `Index`). |
| `title`       | no       | Human-readable name.                                        |
| `description` | no       | One-line summary, surfaced in index listings.               |
| `resource`    | no       | The code path or artifact this page documents.              |
| `tags`        | no       | Free-form keywords for grouping and discovery.              |
| `timestamp`   | no       | Last-meaningful-update time.                                |

`type` is the only field OKF requires. envctl uses `Script` for a page that
documents one script under `scripts/`, `Subsystem` for a broader concern (like
this page), and `Index` for an `index.md`.

## Navigation: `index.md`

An `index.md` file may appear in any directory of the bundle, including the root.
It enumerates that directory's contents to support **progressive disclosure** — a
reader (human or agent) starts at the root `index.md` and follows links down to
the page they need, rather than being handed the whole tree at once. Its body is
one or more sections, each a heading followed by a list of
`[Title](relative-url) — short description` entries drawn from the linked pages'
frontmatter.

envctl requires an `index.md` in every directory that holds docs, so the bundle
is always fully navigable from [`docs/index.md`](index.md).

## Cross-linking

OKF links express relationships between documents; the meaning is carried by the
surrounding prose rather than a dedicated link-type annotation. The spec supports
two target forms:

- **Bundle-relative** (recommended) — begins with `/`, resolved from the bundle
  root. Stable when documents move.
- **Relative** — an ordinary Markdown relative path from the linking document.

envctl's existing pages use relative links; both forms are accepted by the
tooling.

## How envctl enforces OKF

- [check-docs](check-docs.md) fails CI unless every `docs/` page carries valid
  OKF frontmatter with a `type`, and unless the whole bundle is reachable via
  `index.md` links from `docs/index.md`.
- The `docs/` convention itself — one page per script or subsystem, the required
  and recommended frontmatter fields, and the `index.md` rule — is written up in
  `AGENTS.md` → Documentation.

## Related

- [check-docs](check-docs.md) — the CI gate enforcing this format.
- [index](index.md) — the bundle's root index.
