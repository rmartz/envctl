import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runPush } from "../lib/commands/config-push";
import { FatalError } from "../lib/logger";
import { VercelClient } from "../lib/vercel-api";
import { makeDeploymentDir } from "./fixtures";

// ─── runPush — prereqs and dry-run behaviour ──────────────────────────────────

describe("runPush — dry run", () => {
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

  const opts = (deploymentDir: string, targetEnv = "all", dryRun = true) => ({
    targetEnv,
    workingDir: tmpDir,
    deploymentDir,
    dryRun,
  });

  it("throws FatalError when no Vercel token is set", async () => {
    delete process.env.VERCEL_TOKEN;
    const deployDir = makeDeploymentDir(tmpDir, ["production"], {});
    await expect(runPush(opts(deployDir))).rejects.toThrow(FatalError);
  });

  it("throws FatalError when the deployment directory does not exist", async () => {
    await expect(runPush(opts("/nonexistent/path"))).rejects.toThrow(
      FatalError,
    );
  });

  it("throws FatalError when environments.yml is missing", async () => {
    const deployDir = path.join(tmpDir, "deployment");
    fs.mkdirSync(deployDir);
    await expect(runPush(opts(deployDir))).rejects.toThrow(FatalError);
  });

  it("throws FatalError when no active environments are defined", async () => {
    const deployDir = path.join(tmpDir, "deployment");
    fs.mkdirSync(deployDir);
    fs.writeFileSync(path.join(deployDir, "environments.yml"), "active: []\n");
    await expect(runPush(opts(deployDir))).rejects.toThrow(FatalError);
  });

  it("throws FatalError when --env is not in active environments", async () => {
    const deployDir = makeDeploymentDir(tmpDir, ["production"], {
      production: { KEY: "val" },
    });
    await expect(runPush(opts(deployDir, "staging"))).rejects.toThrow(
      FatalError,
    );
  });

  it("dry run logs variables without calling the Vercel API", async () => {
    const create = vi.spyOn(VercelClient.prototype, "createEnvVar");
    const update = vi.spyOn(VercelClient.prototype, "updateEnvVar");
    const list = vi.spyOn(VercelClient.prototype, "listEnvVars");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: string) => logs.push(m));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const deployDir = makeDeploymentDir(tmpDir, ["staging"], {
      staging: { MY_VAR: "hello" },
    });
    await runPush(opts(deployDir));

    expect(logs.some((l) => l.includes("Dry run"))).toBe(true);
    expect(logs.some((l) => l.includes("MY_VAR"))).toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("dry run maps staging → preview in the log output", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: string) => logs.push(m));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const deployDir = makeDeploymentDir(tmpDir, ["staging"], {
      staging: { MY_VAR: "hello" },
    });
    await runPush(opts(deployDir));

    expect(
      logs.some((l) => l.includes("staging") && l.includes("preview")),
    ).toBe(true);
  });

  it("dry run maps production → production", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: string) => logs.push(m));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const deployDir = makeDeploymentDir(tmpDir, ["production"], {
      production: { MY_VAR: "hello" },
    });
    await runPush(opts(deployDir));

    expect(logs.some((l) => /production.*production/.test(l))).toBe(true);
  });

  it("dry run warns when a per-env YAML file is missing", async () => {
    const warnings: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation((m: string) =>
      warnings.push(m),
    );

    const deployDir = makeDeploymentDir(tmpDir, ["staging"], {});
    await runPush(opts(deployDir));

    expect(warnings.some((w) => w.includes("No config file"))).toBe(true);
  });
});
