import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkLive } from "../lib/check-live";
import type { VercelEnvVar } from "../lib/vercel-api";

let tmpDir: string;
let configDir: string;

const envVar = (key: string, target: string): VercelEnvVar => ({
  id: `${key}-${target}`,
  key,
  value: "v",
  target: [target],
  type: "encrypted",
});

async function mockLive(live: VercelEnvVar[]): Promise<void> {
  const { VercelClient } = await import("../lib/vercel-api");
  vi.spyOn(VercelClient.prototype, "listEnvVars").mockResolvedValue({
    envs: live,
    pagination: undefined,
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "check-live-"));
  configDir = path.join(tmpDir, "deployment");
  fs.mkdirSync(configDir);
  fs.writeFileSync(
    path.join(configDir, "manifest.yml"),
    [
      "environments: [production, staging]",
      "deployments:",
      "  - provider: vercel",
      "    targets:",
      "      production: production",
      "      staging: preview",
      "",
    ].join("\n"),
  );
  // Declared public vars per env (what config push manages).
  fs.writeFileSync(path.join(configDir, "production.yml"), 'FOO: "a"\n');
  fs.writeFileSync(path.join(configDir, "staging.yml"), 'FOO: "b"\nBAR: "c"\n');
  vi.stubEnv("VERCEL_TOKEN", "test-token");
  vi.stubEnv("VERCEL_PROJECT_ID", "prj_test");
  delete process.env.VERCEL_TEAM_ID;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("checkLive — drift against the deployment provider (AC8)", () => {
  it("warns about a declared variable missing on its target", async () => {
    // FOO present on both targets; BAR (declared for staging → preview) absent.
    await mockLive([envVar("FOO", "production"), envVar("FOO", "preview")]);
    const found = await checkLive(tmpDir);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
    expect(found[0].message).toMatch(/'BAR'.*staging.*preview/);
  });

  it("returns no findings when every declared variable is live", async () => {
    await mockLive([
      envVar("FOO", "production"),
      envVar("FOO", "preview"),
      envVar("BAR", "preview"),
    ]);
    expect(await checkLive(tmpDir)).toEqual([]);
  });

  it("reports a skipped error instead of crashing when auth is missing", async () => {
    vi.stubEnv("VERCEL_TOKEN", "");
    vi.stubEnv(
      "__VERCEL_CLI_AUTH_PATH",
      path.join(tmpDir, "no-vercel-auth.json"),
    );
    const found = await checkLive(tmpDir);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
    expect(found[0].message).toMatch(/--live.*skipped/i);
  });
});
