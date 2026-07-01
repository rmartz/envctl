import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runPush } from "../lib/commands/config-push";
import { VercelClient } from "../lib/vercel-api";
import { makeDeploymentDir } from "./fixtures";

// ─── runPush — Vercel API create / update ─────────────────────────────────────

describe("runPush — API writes", () => {
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

  it("creates env vars that do not exist", async () => {
    vi.spyOn(VercelClient.prototype, "listEnvVars").mockResolvedValue({
      envs: [],
      pagination: undefined,
    });
    vi.spyOn(VercelClient.prototype, "findEnvVar").mockReturnValue(undefined);
    const mockCreate = vi.fn().mockResolvedValue({ id: "env_new" });
    const mockUpdate = vi.fn();
    vi.spyOn(VercelClient.prototype, "createEnvVar").mockImplementation(
      mockCreate,
    );
    vi.spyOn(VercelClient.prototype, "updateEnvVar").mockImplementation(
      mockUpdate,
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const deployDir = makeDeploymentDir(tmpDir, ["production"], {
      production: { MY_KEY: "my_value" },
    });
    await runPush({
      targetEnv: "all",
      workingDir: tmpDir,
      deploymentDir: deployDir,
      dryRun: false,
    });

    expect(mockCreate).toHaveBeenCalledWith(
      "MY_KEY",
      "my_value",
      "production",
      "plain",
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("updates env vars that already exist", async () => {
    const existing = {
      id: "env_existing",
      key: "MY_KEY",
      target: ["production"],
      value: "old",
      type: "plain" as const,
    };
    vi.spyOn(VercelClient.prototype, "listEnvVars").mockResolvedValue({
      envs: [existing],
      pagination: undefined,
    });
    vi.spyOn(VercelClient.prototype, "findEnvVar").mockReturnValue(existing);
    const mockUpdate = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(VercelClient.prototype, "updateEnvVar").mockImplementation(
      mockUpdate,
    );
    vi.spyOn(VercelClient.prototype, "createEnvVar").mockResolvedValue({
      id: "x",
      key: "k",
      value: "v",
      target: [],
      type: "plain",
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const deployDir = makeDeploymentDir(tmpDir, ["production"], {
      production: { MY_KEY: "new_value" },
    });
    await runPush({
      targetEnv: "all",
      workingDir: tmpDir,
      deploymentDir: deployDir,
      dryRun: false,
    });

    expect(mockUpdate).toHaveBeenCalledWith("env_existing", "new_value");
  });

  it("leaves untouched vars alone (only pushes config keys)", async () => {
    const unrelated = {
      id: "env_other",
      key: "OTHER_KEY",
      target: ["production"],
      value: "keep",
      type: "plain" as const,
    };
    vi.spyOn(VercelClient.prototype, "listEnvVars").mockResolvedValue({
      envs: [unrelated],
      pagination: undefined,
    });
    // Real findEnvVar so OTHER_KEY is genuinely not matched by MY_KEY.
    const mockCreate = vi.fn().mockResolvedValue({ id: "env_new" });
    const mockUpdate = vi.fn();
    const mockDelete = vi.fn();
    vi.spyOn(VercelClient.prototype, "createEnvVar").mockImplementation(
      mockCreate,
    );
    vi.spyOn(VercelClient.prototype, "updateEnvVar").mockImplementation(
      mockUpdate,
    );
    vi.spyOn(VercelClient.prototype, "deleteEnvVar").mockImplementation(
      mockDelete,
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const deployDir = makeDeploymentDir(tmpDir, ["production"], {
      production: { MY_KEY: "my_value" },
    });
    await runPush({
      targetEnv: "all",
      workingDir: tmpDir,
      deploymentDir: deployDir,
      dryRun: false,
    });

    expect(mockCreate).toHaveBeenCalledWith(
      "MY_KEY",
      "my_value",
      "production",
      "plain",
    );
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("pushes only the requested environment with --env", async () => {
    vi.spyOn(VercelClient.prototype, "listEnvVars").mockResolvedValue({
      envs: [],
      pagination: undefined,
    });
    vi.spyOn(VercelClient.prototype, "findEnvVar").mockReturnValue(undefined);
    const mockCreate = vi.fn().mockResolvedValue({ id: "env_new" });
    vi.spyOn(VercelClient.prototype, "createEnvVar").mockImplementation(
      mockCreate,
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const deployDir = makeDeploymentDir(tmpDir, ["production", "staging"], {
      production: { PROD_KEY: "p" },
      staging: { STAGING_KEY: "s" },
    });
    await runPush({
      targetEnv: "production",
      workingDir: tmpDir,
      deploymentDir: deployDir,
      dryRun: false,
    });

    expect(mockCreate).toHaveBeenCalledWith(
      "PROD_KEY",
      "p",
      "production",
      "plain",
    );
    expect(mockCreate).not.toHaveBeenCalledWith(
      "STAGING_KEY",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});
