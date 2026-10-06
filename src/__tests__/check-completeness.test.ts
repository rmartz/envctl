import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkCompleteness,
  checkServiceContext,
  declaredByEnv,
  type EnvDeclaration,
} from "../lib/check-completeness";
import { parseManifest } from "../lib/manifest";
import type { DeploymentProvider } from "../lib/providers/deployment";
import { envTargetResolver } from "../lib/targets";
import { makeDeploymentDir, makeLiveVar, makeManifestDir } from "./fixtures";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "check-complete-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const HEADER = [
  "environments: [production, staging]",
  "deployments:",
  "  - provider: vercel",
  "    targets:",
  "      production: production",
  "      staging: preview",
];

// Resolve the declarations for a deployment dir, keyed by environment.
function declarations(configDir: string): Record<string, EnvDeclaration> {
  const manifest = parseManifest(configDir);
  const ctx = checkServiceContext(manifest, {} as DeploymentProvider);
  const decls = declaredByEnv(
    configDir,
    manifest,
    ctx,
    envTargetResolver(configDir),
  );
  return Object.fromEntries(decls.map((d) => [d.env, d]));
}

const makeDecl = (
  env: string,
  target: string,
  required: string[],
  known: string[] = required,
): EnvDeclaration => ({
  env,
  target,
  required: new Set(required),
  known: new Set(known),
});

describe("declaredByEnv — the declared set per environment", () => {
  it("requires a top-level variable in every environment", () => {
    const dir = makeManifestDir(tmpDir, [
      ...HEADER,
      "variables:",
      "  APP_NAME: { value: budget }",
    ]);
    expect(declarations(dir).staging.required.has("APP_NAME")).toBe(true);
  });

  it("requires a scoped group's variable only in its environments", () => {
    const dir = makeManifestDir(tmpDir, [
      ...HEADER,
      "variableGroups:",
      "  - name: cron",
      "    environments: [production]",
      "    variables:",
      "      CRON_SECRET: { generate: true }",
    ]);
    expect(declarations(dir).staging.required.has("CRON_SECRET")).toBe(false);
  });

  it("counts a generated secret as declared", () => {
    const dir = makeManifestDir(tmpDir, [
      ...HEADER,
      "variables:",
      "  CRON_SECRET: { generate: true }",
    ]);
    expect(declarations(dir).production.required.has("CRON_SECRET")).toBe(true);
  });

  it("requires an overlay key in its own environment", () => {
    const dir = makeManifestDir(tmpDir, HEADER, {
      production: { NEXT_PUBLIC_APP_ENV: "production" },
    });
    expect(
      declarations(dir).production.required.has("NEXT_PUBLIC_APP_ENV"),
    ).toBe(true);
  });

  it("requires a service's contract vars under its mapped names", () => {
    const dir = makeManifestDir(tmpDir, [
      ...HEADER,
      "services:",
      "  - provider: firebase",
      "    variables:",
      "      privateKey: FB_PRIVATE_KEY",
    ]);
    expect(declarations(dir).production.required.has("FB_PRIVATE_KEY")).toBe(
      true,
    );
  });

  it("requires PostHog's contract vars under their renamed names", () => {
    const dir = makeManifestDir(tmpDir, [
      ...HEADER,
      "services:",
      "  - provider: posthog",
      "    variables:",
      "      projectKey: PH_KEY",
      "      host: PH_HOST",
    ]);
    const prod = declarations(dir).production;
    expect([...prod.required].sort()).toEqual(["PH_HOST", "PH_KEY"]);
  });

  it("does not require a service's vars outside its scope", () => {
    const dir = makeManifestDir(tmpDir, [
      ...HEADER,
      "services:",
      "  - provider: firebase",
      "    environments: [production]",
    ]);
    expect(declarations(dir).staging.required.has("FIREBASE_PRIVATE_KEY")).toBe(
      false,
    );
  });

  it("tolerates but does not require a service's legacy alias", () => {
    const dir = makeManifestDir(tmpDir, [
      ...HEADER,
      "services:",
      "  - provider: sentry",
    ]);
    const prod = declarations(dir).production;
    expect([
      prod.required.has("SENTRY_DSN"),
      prod.known.has("SENTRY_DSN"),
    ]).toEqual([false, true]);
  });

  it("tolerates every registered service's vars in a legacy config", () => {
    const dir = makeDeploymentDir(tmpDir, ["production"], {
      production: { FOO: "a" },
    });
    const prod = declarations(dir).production;
    expect([
      prod.required.has("FIREBASE_PRIVATE_KEY"),
      prod.known.has("FIREBASE_PRIVATE_KEY"),
    ]).toEqual([false, true]);
  });
});

describe("checkCompleteness — missing and orphaned variables", () => {
  it("errors on a declared variable absent from its target", () => {
    const found = checkCompleteness(
      [makeDecl("production", "production", ["FIREBASE_PRIVATE_KEY"])],
      [],
    );
    expect(found).toEqual([
      expect.objectContaining({
        severity: "error",
        kind: "missing",
        target: "production",
        key: "FIREBASE_PRIVATE_KEY",
      }),
    ]);
  });

  it("does not flag a declared variable present only on another target", () => {
    const found = checkCompleteness(
      [makeDecl("production", "production", ["FOO"])],
      [makeLiveVar("FOO", "preview")],
    );
    expect(found.map((f) => f.kind)).toEqual(["missing"]);
  });

  it("reports a missing variable once when two environments share a target", () => {
    const found = checkCompleteness(
      [
        makeDecl("staging", "preview", ["FOO"]),
        makeDecl("preview", "preview", ["FOO"]),
      ],
      [],
    );
    expect(found).toHaveLength(1);
  });

  it("warns on a live variable declared nowhere", () => {
    const found = checkCompleteness(
      [makeDecl("production", "production", [])],
      [makeLiveVar("FIREBASE_SERVICE_ACCOUNT", "production")],
    );
    expect(found).toEqual([
      expect.objectContaining({
        severity: "warning",
        kind: "orphaned",
        target: "production",
        key: "FIREBASE_SERVICE_ACCOUNT",
      }),
    ]);
  });

  it("does not flag a known-but-not-required variable as orphaned", () => {
    const found = checkCompleteness(
      [makeDecl("production", "production", [], ["SENTRY_DSN"])],
      [makeLiveVar("SENTRY_DSN", "production")],
    );
    expect(found).toEqual([]);
  });

  it("ignores Vercel system variables", () => {
    const found = checkCompleteness(
      [makeDecl("production", "production", [])],
      [makeLiveVar("VERCEL_URL", "production")],
    );
    expect(found).toEqual([]);
  });

  it("does not check targets no environment maps to", () => {
    const found = checkCompleteness(
      [makeDecl("production", "production", [])],
      [makeLiveVar("STRAY", "development")],
    );
    expect(found).toEqual([]);
  });
});
