import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkStatic, type Finding } from "../lib/check";
import { runCheck } from "../lib/commands/check";
import { FatalError } from "../lib/logger";

let tmpDir: string;
let configDir: string;

// A valid baseline manifest each test mutates. production → production,
// staging → preview; a prod-only firebase service and a prod-only cron group.
const VALID = [
  "environments: [production, staging]",
  "deployments:",
  "  - provider: vercel",
  "    targets:",
  "      production: production",
  "      staging: preview",
  "services:",
  "  - provider: firebase",
  "    environments: [production]",
  "variableGroups:",
  "  - name: cron",
  "    environments: [production]",
  "    variables:",
  "      CRON_SECRET:",
  "        generate: true",
  "",
].join("\n");

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "check-test-"));
  configDir = path.join(tmpDir, "deployment");
  fs.mkdirSync(configDir);
  // Identity resolves by default, so the identity warning is off unless a test
  // opts into it.
  vi.stubEnv("VERCEL_PROJECT_ID", "prj_test");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const writeManifest = (content: string): void =>
  fs.writeFileSync(path.join(configDir, "manifest.yml"), content);
const errors = (findings: Finding[]): string[] =>
  findings.filter((f) => f.severity === "error").map((f) => f.message);
const warnings = (findings: Finding[]): string[] =>
  findings.filter((f) => f.severity === "warning").map((f) => f.message);
const hasError = (findings: Finding[], re: RegExp): boolean =>
  errors(findings).some((m) => re.test(m));

describe("checkStatic — all-clear", () => {
  it("returns no findings for a coherent manifest", () => {
    writeManifest(VALID);
    expect(checkStatic(tmpDir)).toEqual([]);
  });

  it("errors when no deployment config exists at all", () => {
    fs.rmSync(configDir, { recursive: true, force: true });
    expect(errors(checkStatic(tmpDir))[0]).toMatch(/No deployment config/);
  });
});

describe("checkStatic — manifest parses and environments resolve (AC1)", () => {
  it("reports a parse failure instead of throwing", () => {
    writeManifest("environments: [production, staging"); // unterminated flow
    const found = errors(checkStatic(tmpDir));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/failed to parse/);
  });

  it("errors when a declared environment resolves to an invalid target", () => {
    writeManifest(
      [
        "environments: [production, qa]",
        "deployments:",
        "  - provider: vercel",
        "    targets:",
        "      production: production",
        "",
      ].join("\n"),
    );
    // qa has no target mapping and the name convention yields 'qa' — not a
    // valid Vercel target.
    expect(errors(checkStatic(tmpDir))).toEqual([
      expect.stringMatching(/'qa'.*invalid.*target/i),
    ]);
  });
});

describe("checkStatic — deployment target mapping (AC2)", () => {
  it("errors when a targets key is not a declared environment", () => {
    writeManifest(
      [
        "environments: [production]",
        "deployments:",
        "  - provider: vercel",
        "    targets:",
        "      production: production",
        "      staging: preview",
        "",
      ].join("\n"),
    );
    expect(
      hasError(checkStatic(tmpDir), /undeclared environment 'staging'/),
    ).toBe(true);
  });

  it("errors when a target value is invalid for the provider", () => {
    writeManifest(
      [
        "environments: [production]",
        "deployments:",
        "  - provider: vercel",
        "    targets:",
        "      production: prod",
        "",
      ].join("\n"),
    );
    expect(hasError(checkStatic(tmpDir), /invalid target 'prod'/)).toBe(true);
  });
});

describe("checkStatic — overlay ↔ declaration (AC3)", () => {
  it("errors on an orphan overlay file with no matching environment", () => {
    writeManifest(VALID);
    fs.writeFileSync(path.join(configDir, "production.yml"), 'FOO: "bar"\n');
    fs.writeFileSync(path.join(configDir, "qa.yml"), 'FOO: "bar"\n');
    const found = errors(checkStatic(tmpDir));
    // Only the undeclared 'qa' overlay is orphaned; the declared 'production'
    // overlay is fine.
    expect(found).toEqual([expect.stringMatching(/overlay file 'qa.yml'/)]);
  });
});

describe("checkStatic — providers are registered (AC4)", () => {
  it("errors on an unknown deployment provider", () => {
    writeManifest(
      [
        "environments: [production]",
        "deployments:",
        "  - provider: netlify",
        "    targets:",
        "      production: production",
        "",
      ].join("\n"),
    );
    expect(
      hasError(checkStatic(tmpDir), /unknown deployment provider 'netlify'/),
    ).toBe(true);
  });

  it("errors on an unknown service provider", () => {
    writeManifest(
      [
        "environments: [production]",
        "services:",
        "  - provider: datadog",
        "",
      ].join("\n"),
    );
    expect(
      hasError(checkStatic(tmpDir), /unknown service provider 'datadog'/),
    ).toBe(true);
  });
});

describe("checkStatic — scopes reference declared environments (AC5)", () => {
  it("errors when a service is scoped to an undeclared environment", () => {
    writeManifest(
      [
        "environments: [production]",
        "services:",
        "  - provider: firebase",
        "    environments: [nonprod]",
        "",
      ].join("\n"),
    );
    expect(
      hasError(
        checkStatic(tmpDir),
        /service 'firebase'.*undeclared environment 'nonprod'/,
      ),
    ).toBe(true);
  });

  it("errors when a variable group is scoped to an undeclared environment", () => {
    writeManifest(
      [
        "environments: [production]",
        "variableGroups:",
        "  - name: cron",
        "    environments: [nonprod]",
        "    variables:",
        "      CRON_SECRET:",
        "        generate: true",
        "",
      ].join("\n"),
    );
    expect(
      hasError(
        checkStatic(tmpDir),
        /variable group 'cron'.*undeclared environment 'nonprod'/,
      ),
    ).toBe(true);
  });
});

describe("checkStatic — deployment identity (AC6)", () => {
  it("warns (not errors) when Vercel identity does not resolve", () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "");
    writeManifest(VALID);
    const found = checkStatic(tmpDir);
    expect(errors(found)).toEqual([]);
    expect(warnings(found)).toEqual([
      expect.stringMatching(/identity not resolved/i),
    ]);
  });

  it("does not warn when .vercel/project.json is present", () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "");
    fs.mkdirSync(path.join(tmpDir, ".vercel"));
    fs.writeFileSync(
      path.join(tmpDir, ".vercel", "project.json"),
      JSON.stringify({ projectId: "prj_x" }),
    );
    writeManifest(VALID);
    expect(warnings(checkStatic(tmpDir))).toEqual([]);
  });
});

describe("runCheck — command behavior (AC7)", () => {
  it("prints an OK summary and does not throw on a clean project", async () => {
    writeManifest(VALID);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runCheck({ workingDir: tmpDir }, []);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/OK/);
  });

  it("throws a FatalError (non-zero exit) when an error is found", async () => {
    writeManifest(VALID);
    fs.writeFileSync(path.join(configDir, "qa.yml"), 'FOO: "bar"\n');
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(runCheck({ workingDir: tmpDir }, [])).rejects.toBeInstanceOf(
      FatalError,
    );
  });

  it("rejects an unknown option", async () => {
    writeManifest(VALID);
    await expect(
      runCheck({ workingDir: tmpDir }, ["--bogus"]),
    ).rejects.toBeInstanceOf(FatalError);
  });
});
