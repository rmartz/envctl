#!/usr/bin/env node
/**
 * Package-pin check — enforces the CLAUDE.md rule that every package.json
 * dependency range specifies a full major.minor.patch base (keeping its ^/~
 * operator), so a Dependabot bump always surfaces as an explicit package.json
 * change rather than a lock-file-only edit. See CLAUDE.md and trip-split#114.
 *
 * Usage: node scripts/check-package-pins.mjs
 */
import * as fs from "node:fs";

const MANIFESTS = ["package.json"];
const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

// A compliant range: an optional ^ or ~ operator followed by a full
// major.minor.patch, optionally with a prerelease/build suffix.
const FULL_PIN = /^[\^~]?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

// Non-registry specifiers are exempt — their version is not a semver range
// Dependabot tracks against the manifest.
const SKIP =
  /^(workspace:|catalog:|link:|file:|git\+|git:|github:|https?:|npm:|\*$|latest$)/;

function checkManifest(path) {
  if (!fs.existsSync(path)) return [];
  const pkg = JSON.parse(fs.readFileSync(path, "utf-8"));
  const offenders = [];
  for (const field of DEP_FIELDS) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range !== "string" || SKIP.test(range)) continue;
      if (!FULL_PIN.test(range)) {
        offenders.push({ path, field, name, range });
      }
    }
  }
  return offenders;
}

function main() {
  const offenders = MANIFESTS.flatMap(checkManifest);
  if (offenders.length > 0) {
    console.error(
      "Package-pin check failed — every dependency must pin a full " +
        "major.minor.patch (see CLAUDE.md). Offending ranges:",
    );
    for (const o of offenders) {
      console.error(`  ${o.path} → ${o.field}.${o.name}: "${o.range}"`);
    }
    process.exit(1);
  }
  console.log("Package-pin check: ok");
}

main();
