import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runPush } from "../lib/commands/config-push";
import { VercelClient } from "../lib/vercel-api";
import { makeDeploymentDir } from "./fixtures";

// ─── runPush — implicit development target (mirrors staging) ──────────────────
//
// Development has no dedicated YAML file. Its public vars are always sourced
// from the staging/preview YAML.

describe("runPush — development target", () => {
  let tmpDir: string;
  let origEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-push-test-"));
    origEnv = { ...process.env };
    process.env.VERCEL_TOKEN = "test-token";
    process.env.VERCEL_PROJECT_ID = "prj_test";
    delete process.env.VERCEL_TEAM_ID;
  });

  afterEach(() => {
    process.env = origEnv;
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("pushes staging vars to development when --env development", async () => {
    vi.spyOn(VercelClient.prototype, "listEnvVars").mockResolvedValue({
      envs: [],
      pagination: undefined,
    });
    vi.spyOn(VercelClient.prototype, "findEnvVar").mockReturnValue(undefined);
    const mockCreate = vi.fn().mockResolvedValue({
      id: "x",
      key: "k",
      value: "v",
      target: [],
      type: "plain",
    });
    vi.spyOn(VercelClient.prototype, "createEnvVar").mockImplementation(
      mockCreate,
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const deployDir = makeDeploymentDir(tmpDir, ["staging"], {
      staging: { STAGING_KEY: "staging-val" },
    });
    await runPush({
      targetEnv: "development",
      workingDir: tmpDir,
      deploymentDir: deployDir,
      dryRun: false,
    });

    expect(mockCreate).toHaveBeenCalledWith(
      "STAGING_KEY",
      "staging-val",
      "development",
      "plain",
    );
    // --env development pushes ONLY development, not preview.
    expect(mockCreate).not.toHaveBeenCalledWith(
      "STAGING_KEY",
      "staging-val",
      "preview",
      "plain",
    );
  });

  it("pushes staging vars to both preview and development when --env all", async () => {
    vi.spyOn(VercelClient.prototype, "listEnvVars").mockResolvedValue({
      envs: [],
      pagination: undefined,
    });
    vi.spyOn(VercelClient.prototype, "findEnvVar").mockReturnValue(undefined);
    const mockCreate = vi.fn().mockResolvedValue({
      id: "x",
      key: "k",
      value: "v",
      target: [],
      type: "plain",
    });
    vi.spyOn(VercelClient.prototype, "createEnvVar").mockImplementation(
      mockCreate,
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const deployDir = makeDeploymentDir(tmpDir, ["staging"], {
      staging: { STAGING_KEY: "staging-val" },
    });
    await runPush({
      targetEnv: "all",
      workingDir: tmpDir,
      deploymentDir: deployDir,
      dryRun: false,
    });

    expect(mockCreate).toHaveBeenCalledWith(
      "STAGING_KEY",
      "staging-val",
      "preview",
      "plain",
    );
    expect(mockCreate).toHaveBeenCalledWith(
      "STAGING_KEY",
      "staging-val",
      "development",
      "plain",
    );
  });

  it("dry run shows development sync sourced from staging", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: string) => logs.push(m));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const deployDir = makeDeploymentDir(tmpDir, ["staging"], {
      staging: { STAGING_KEY: "staging-val" },
    });
    await runPush({
      targetEnv: "development",
      workingDir: tmpDir,
      deploymentDir: deployDir,
      dryRun: true,
    });

    expect(logs.some((l) => l.includes("development"))).toBe(true);
    expect(logs.some((l) => l.includes("STAGING_KEY"))).toBe(true);
    expect(logs.some((l) => l.includes("staging"))).toBe(true);
  });
});
