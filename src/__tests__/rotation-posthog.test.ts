import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { run } from "../lib/rotation";

// PostHog is a manual-only provider (#173): the rotation engine never mints for
// it, refuses an explicit init/rotate with the manual steps, and warns when an
// unscoped rotate finds its personal API key present.
describe("run — PostHog manual-only provider", () => {
  let origEnv: NodeJS.ProcessEnv;
  let tmpDir: string;
  let deployDir: string;

  beforeEach(() => {
    origEnv = { ...process.env };
    process.env.VERCEL_TOKEN = "test-token";
    process.env.VERCEL_PROJECT_ID = "prj_test";
    delete process.env.VERCEL_TEAM_ID;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rotate-posthog-"));
    deployDir = path.join(tmpDir, "deployment");
    fs.mkdirSync(deployDir);
  });

  afterEach(() => {
    process.env = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function mockVercel(keys: string[]) {
    const subprocess = await import("../lib/subprocess");
    vi.spyOn(subprocess, "commandExists").mockReturnValue(true);
    vi.spyOn(subprocess, "run").mockReturnValue("rmartz");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { VercelClient } = await import("../lib/vercel-api");
    vi.spyOn(VercelClient.prototype, "listEnvVars").mockResolvedValue({
      envs: keys.map((key, i) => ({
        id: `k${i}`,
        key,
        value: "v",
        target: ["production"],
        type: "encrypted" as const,
      })),
      pagination: undefined,
    });
    const deployments = await import("../lib/deployments");
    return vi
      .spyOn(deployments, "triggerAndWaitRedeployments")
      .mockResolvedValue(undefined);
  }

  const opts = (extra: object) => ({
    targetEnv: "production",
    invalidateKeys: true,
    workingDir: tmpDir,
    deploymentDir: deployDir,
    ...extra,
  });

  it("refuses `secrets rotate posthog` with the manual steps", async () => {
    await mockVercel(["POSTHOG_PERSONAL_API_KEY"]);
    await expect(run(opts({ provider: "posthog" }))).rejects.toThrow(
      /cannot be created, rolled, or deleted through the PostHog API/,
    );
  });

  it("refuses `secrets init posthog` with the manual steps", async () => {
    await mockVercel([]);
    await expect(run(opts({ init: "posthog" }))).rejects.toThrow(
      /cannot be created, rolled, or deleted through the PostHog API/,
    );
  });

  it("warns with the manual steps when an unscoped rotate finds the key", async () => {
    await mockVercel(["POSTHOG_PERSONAL_API_KEY", "FIREBASE_PRIVATE_KEY"]);
    const firebase = await import("../lib/firebase");
    vi.spyOn(firebase, "rotateFirebase").mockResolvedValue({
      oldKeys: [],
      fp: null,
    });
    const warnSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await run(opts({ invalidateKeys: false }));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("does not rotate POSTHOG_PERSONAL_API_KEY"),
    );
  });

  it("treats a project with only a PostHog key as having nothing to rotate", async () => {
    const redeploy = await mockVercel(["POSTHOG_PERSONAL_API_KEY"]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(run(opts({}))).rejects.toThrow(/nothing to rotate/);
    expect(redeploy).not.toHaveBeenCalled();
  });

  it("detects the personal key under its manifest-overridden name", async () => {
    fs.writeFileSync(
      path.join(deployDir, "manifest.yml"),
      "services:\n  - provider: posthog\n    variables:\n      personalApiKey: PH_ADMIN_KEY\n",
    );
    await mockVercel(["PH_ADMIN_KEY", "FIREBASE_PRIVATE_KEY"]);
    const firebase = await import("../lib/firebase");
    vi.spyOn(firebase, "rotateFirebase").mockResolvedValue({
      oldKeys: [],
      fp: null,
    });
    const warnSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await run(opts({ invalidateKeys: false }));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("does not rotate PH_ADMIN_KEY"),
    );
  });
});
