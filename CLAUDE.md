# envctl — repository conventions

envctl is a personal, `gh`-style CLI for managing deploy configuration and
provider secrets across projects. See [the vision](https://github.com/rmartz/envctl/issues/1)
for the overall design.

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
