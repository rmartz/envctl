import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { run, serviceScopeTargets } from "../lib/rotation";

describe("serviceScopeTargets", () => {
  let deployDir: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-test-"));
    deployDir = path.join(tmpDir, "deployment");
    fs.mkdirSync(deployDir);
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const write = (content: string): void =>
    fs.writeFileSync(path.join(deployDir, "manifest.yml"), content);

  it("resolves a scoped service's environments to their targets", () => {
    write(
      [
        "environments: [production, staging]",
        "services:",
        "  - provider: firebase",
        "    environments: [production, staging]",
      ].join("\n") + "\n",
    );
    // production → production, staging → preview (dedup keeps distinct targets).
    expect(serviceScopeTargets(deployDir, "firebase")).toEqual([
      "production",
      "preview",
    ]);
  });

  it("returns a single target for a prod-only service", () => {
    write(
      [
        "environments: [production, staging]",
        "services:",
        "  - provider: firebase",
        "    environments: [production]",
      ].join("\n") + "\n",
    );
    expect(serviceScopeTargets(deployDir, "firebase")).toEqual(["production"]);
  });

  it("is undefined for a service with no declared environments (unscoped)", () => {
    write("environments: [production]\nservices:\n  - provider: firebase\n");
    expect(serviceScopeTargets(deployDir, "firebase")).toBeUndefined();
  });

  it("is undefined when the service is not declared", () => {
    write("environments: [production]\n");
    expect(serviceScopeTargets(deployDir, "firebase")).toBeUndefined();
  });
});

describe("run — environment-scoped services (#89)", () => {
  let origEnv: NodeJS.ProcessEnv;
  let deployDir: string;
  let tmpDir: string;

  beforeEach(() => {
    origEnv = { ...process.env };
    process.env.VERCEL_TOKEN = "test-token";
    process.env.VERCEL_PROJECT_ID = "prj_test";
    delete process.env.VERCEL_TEAM_ID;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-run-"));
    deployDir = path.join(tmpDir, "deployment");
    fs.mkdirSync(deployDir);
    // Firebase declared prod-only.
    fs.writeFileSync(
      path.join(deployDir, "manifest.yml"),
      [
        "environments: [production, staging]",
        "services:",
        "  - provider: firebase",
        "    environments: [production]",
      ].join("\n") + "\n",
    );
  });

  afterEach(() => {
    process.env = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function mocks() {
    const subprocess = await import("../lib/subprocess");
    vi.spyOn(subprocess, "commandExists").mockReturnValue(true);
    vi.spyOn(subprocess, "run").mockReturnValue("rmartz");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    // Firebase (split) present on BOTH production and preview.
    const { VercelClient } = await import("../lib/vercel-api");
    vi.spyOn(VercelClient.prototype, "listEnvVars").mockResolvedValue({
      envs: ["production", "preview"].map((t, i) => ({
        id: `k${i}`,
        key: "FIREBASE_PRIVATE_KEY",
        value: "pk",
        target: [t],
        type: "encrypted" as const,
      })),
      pagination: undefined,
    });

    const deployments = await import("../lib/deployments");
    vi.spyOn(deployments, "triggerAndWaitRedeployments").mockResolvedValue(
      undefined,
    );
    return import("../lib/firebase");
  }

  it("skips a prod-only service when rotating a staging (preview) target", async () => {
    const firebase = await mocks();
    const rotateSpy = vi
      .spyOn(firebase, "rotateFirebase")
      .mockResolvedValue({ oldKeys: [], fp: null });

    await run({
      targetEnv: "preview",
      invalidateKeys: false,
      workingDir: tmpDir,
      deploymentDir: deployDir,
    });

    expect(rotateSpy).not.toHaveBeenCalled();
  });

  it("rotates the prod-only service when the target is in scope", async () => {
    const firebase = await mocks();
    const rotateSpy = vi
      .spyOn(firebase, "rotateFirebase")
      .mockResolvedValue({ oldKeys: [], fp: null });

    await run({
      targetEnv: "production",
      invalidateKeys: false,
      workingDir: tmpDir,
      deploymentDir: deployDir,
    });

    expect(rotateSpy).toHaveBeenCalledOnce();
  });
});
