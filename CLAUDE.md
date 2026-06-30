# envctl — repository conventions

envctl is a personal, `gh`-style CLI for managing deploy configuration and
provider secrets across projects. See [the vision](https://github.com/rmartz/envctl/issues/1)
for the overall design.

These are envctl-specific conventions; general engineering and Git/PR workflow
rules are not repeated here.

## Common Commands

Always use `pnpm` (never `npm` or `yarn`).

```bash
pnpm build                  # Compile to dist/ (tsc) and chmod the envctl bin
pnpm typecheck              # Type-check only (tsc --noEmit)
pnpm lint                   # ESLint (fails on any warning)
pnpm format                 # Prettier --write
pnpm run format:check       # Prettier --check
pnpm run test:ts            # Run the Vitest suite
pnpm run check:file-length  # File-length ratchet
pnpm run check:package-pins # Enforce full major.minor.patch pins
```

## TypeScript

- Strict mode throughout (`tsconfig` `strict: true`). No `any`, no `@ts-ignore`.
- Prefer `undefined` over `null` for absent/optional values. Use `null` only
  where an external API requires it (e.g. `js-yaml`'s `load()` returning `null`).
- Favor `async`/`await` over `.then()` chains.
- **Prefer enums over string-literal unions** for any domain concept with two or
  more named states — `enum DeployTarget { Development = "development", Preview =
"preview", Production = "production" }` rather than a `"production" | "preview"`
  union. Keep enum members (and constant-object keys) in alphabetical order to
  minimize merge conflicts, and make each enum string value match the serialized
  form it maps to.

## Code Conventions

- Use **named exports**, not default exports.
- **No IIFEs.** Extract the logic into a named helper or compute the value with a
  plain expression.
- **No spurious variables.** Do not assign a value only to return it on the next
  line — return the expression directly.
- **No inline `import("…").Type` annotations.** Use module-level
  `import type { … } from "…"`. A dynamic `await import("…")` for conditionally
  loaded modules is fine.

## File Organization

- **Source files**: keep under ~200 lines (split at ~240). ESLint `max-lines`
  hard-caps source at 480 and the `check:file-length` ratchet enforces it in CI.
  Split large files by logical concern.
- **Test files**: use the `.test.ts` extension, under `src/__tests__/`. Keep
  under ~300 lines (split at ~360); the ratchet hard-caps tests at 720. When a
  suite grows large, split it into a `{module}-tests/` directory with
  domain-specific files.

## Testing

- Use `describe`/`it` from Vitest (not `test`).
- Test fixture generators use `make{Domain}()` (e.g. `makeProject()`), kept in
  `src/__tests__/fixtures.ts` or a co-located fixtures module.
- **Control inputs and outputs.** Assert against explicit, non-default values, so
  a passing test proves the value came from logic — not from an initializer
  (unless the test is specifically about defaults).
- **One reason to fail per test.** Assert a single logical outcome; if a test
  exercises two functions it should be testing their interaction explicitly.
- **Keep tests simple.** A failure should make it immediately obvious whether
  it's a bug or an intended behavior change.
- **Granularity scales with abstraction.** Pure utilities (parsers, mappers)
  warrant thorough edge-case coverage; orchestration code gets smoke tests that
  verify it wires the lower-level logic together, not a re-test of every edge case.

## Dependencies

- **Pin the full `major.minor.patch` in `package.json`.** Every entry in
  `dependencies` and `devDependencies` must specify a complete
  `major.minor.patch` version, even when using a range annotation — write
  `"prettier": "^3.8.4"`, never `"prettier": "^3"` or `"^3.8"`.

  **Why:** Dependabot only edits `package.json` when the new version falls
  outside the declared specifier. A partial pin like `^3` already satisfies any
  `3.x` release, so a minor/patch bump updates **only** `pnpm-lock.yaml` and
  leaves `package.json` untouched — making the dependency change invisible in a
  `package.json` diff. A full pin (`^3.8.4`) forces every bump to also bump the
  `package.json` specifier, so the update is explicitly visible and reviewable.
  This is exactly the failure seen in
  [trip-split#114](https://github.com/rmartz/trip-split/pull/114), where a
  Prettier minor bump that required reformatting showed no `package.json` change.

  This applies to caret (`^`) and tilde (`~`) ranges as well as exact pins. The
  `engines` field (minimum-version constraints like `node: ">=18"`) is exempt —
  it is a compatibility floor, not a dependency pin.

  Enforced by `scripts/check-package-pins.mjs` (the `Package pins` CI workflow).

## Documentation

- Keep documentation in sync with the code — outdated docs are worse than none.
- Reference pages for scripts and subsystems live under `docs/`, in Google's Open
  Knowledge Format (OKF): one markdown file per script or subsystem, each with
  YAML frontmatter (`type` required — `Script` / `Subsystem` / `Index`; `title`,
  `description`, `resource`, `tags` recommended). Create `docs/README.md` as the
  index when the first page is added, and cross-link related pages with plain
  markdown links.
- When you add or non-trivially change a script under `scripts/` or a subsystem,
  add or update its `docs/` page in the same PR. Existing undocumented code is
  tech debt to migrate over time — this does not require unrelated backfill.
