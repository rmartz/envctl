import * as fs from "fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FatalError } from "../lib/logger";
import { run } from "../lib/rotation";

// ─── run — prerequisite checks ────────────────────────────────────────────────

describe("run — prerequisite checks", () => {
  let origEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    origEnv = { ...process.env };
    process.env.VERCEL_TOKEN = "test-token";
    process.env.VERCEL_PROJECT_ID = "prj_test";
    delete process.env.VERCEL_TEAM_ID;
  });

  afterEach(() => {
    process.env = origEnv;
    vi.restoreAllMocks();
  });

  it("throws FatalError when VERCEL_TOKEN is not set", async () => {
    delete process.env.VERCEL_TOKEN;
    const subprocess = await import("../lib/subprocess");
    vi.spyOn(subprocess, "commandExists").mockReturnValue(true);
    vi.spyOn(subprocess, "run").mockReturnValue("rmartz");

    await expect(
      run({ targetEnv: "all", invalidateKeys: true }),
    ).rejects.toThrow(FatalError);
  });

  it("throws FatalError when vercel CLI is missing", async () => {
    const subprocess = await import("../lib/subprocess");
    vi.spyOn(subprocess, "commandExists").mockImplementation(
      (cmd) => cmd !== "vercel",
    );

    await expect(
      run({ targetEnv: "all", invalidateKeys: true }),
    ).rejects.toThrow(FatalError);
  });

  it("throws FatalError when gcloud CLI is missing", async () => {
    const subprocess = await import("../lib/subprocess");
    vi.spyOn(subprocess, "commandExists").mockImplementation(
      (cmd) => cmd !== "gcloud",
    );

    await expect(
      run({ targetEnv: "all", invalidateKeys: true }),
    ).rejects.toThrow(FatalError);
  });

  it("throws FatalError when vercel CLI is not authenticated", async () => {
    const subprocess = await import("../lib/subprocess");
    vi.spyOn(subprocess, "commandExists").mockReturnValue(true);
    vi.spyOn(subprocess, "run").mockImplementation((cmd, args) => {
      if (cmd === "vercel" && args.includes("whoami")) {
        throw new Error("not authenticated");
      }
      return "";
    });

    await expect(
      run({ targetEnv: "all", invalidateKeys: true }),
    ).rejects.toThrow(FatalError);
    await expect(
      run({ targetEnv: "all", invalidateKeys: true }),
    ).rejects.toThrow("authenticated");
  });

  it("throws FatalError when VERCEL_PROJECT_ID is not set and no project.json exists", async () => {
    delete process.env.VERCEL_PROJECT_ID;
    const subprocess = await import("../lib/subprocess");
    vi.spyOn(subprocess, "commandExists").mockReturnValue(true);
    vi.spyOn(subprocess, "run").mockReturnValue("rmartz");

    await expect(
      run({ targetEnv: "all", invalidateKeys: true }),
    ).rejects.toThrow(FatalError);
  });

  it("throws FatalError when no Firebase or Sentry keys are found", async () => {
    const subprocess = await import("../lib/subprocess");
    vi.spyOn(subprocess, "commandExists").mockReturnValue(true);
    vi.spyOn(subprocess, "run").mockReturnValue("rmartz");

    const { VercelClient } = await import("../lib/vercel-api");
    vi.spyOn(VercelClient.prototype, "listEnvVars").mockResolvedValue({
      envs: [],
      pagination: undefined,
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      run({ targetEnv: "all", invalidateKeys: true }),
    ).rejects.toThrow(FatalError);
    await expect(
      run({ targetEnv: "all", invalidateKeys: true }),
    ).rejects.toThrow("No Firebase or Sentry");
    await expect(
      run({ targetEnv: "all", invalidateKeys: true }),
    ).rejects.toThrow("--init");
  });
});

// ─── run — --init guard checks ────────────────────────────────────────────────

describe("run — --init guard checks", () => {
  let origEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    origEnv = { ...process.env };
    process.env.VERCEL_TOKEN = "test-token";
    process.env.VERCEL_PROJECT_ID = "prj_test";
    delete process.env.VERCEL_TEAM_ID;
  });

  afterEach(() => {
    process.env = origEnv;
    vi.restoreAllMocks();
  });

  async function setupMocks() {
    const subprocess = await import("../lib/subprocess");
    vi.spyOn(subprocess, "commandExists").mockReturnValue(true);
    vi.spyOn(subprocess, "run").mockReturnValue("rmartz");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  }

  it("throws FatalError when --init firebase and Firebase keys already exist", async () => {
    await setupMocks();
    const { VercelClient } = await import("../lib/vercel-api");
    vi.spyOn(VercelClient.prototype, "listEnvVars").mockResolvedValue({
      envs: [
        {
          id: "e1",
          key: "FIREBASE_SERVICE_ACCOUNT",
          value: "{}",
          target: ["production"],
          type: "encrypted",
        },
      ],
      pagination: undefined,
    });

    await expect(
      run({ targetEnv: "all", invalidateKeys: true, init: "firebase" }),
    ).rejects.toThrow(FatalError);
    await expect(
      run({ targetEnv: "all", invalidateKeys: true, init: "firebase" }),
    ).rejects.toThrow("already exist");
  });

  it("throws FatalError when --init sentry and Sentry keys already exist", async () => {
    await setupMocks();
    const { VercelClient } = await import("../lib/vercel-api");
    vi.spyOn(VercelClient.prototype, "listEnvVars").mockResolvedValue({
      envs: [
        {
          id: "e1",
          key: "NEXT_PUBLIC_SENTRY_DSN",
          value: "https://abc@sentry.io/1",
          target: ["production"],
          type: "plain",
        },
      ],
      pagination: undefined,
    });

    await expect(
      run({ targetEnv: "all", invalidateKeys: true, init: "sentry" }),
    ).rejects.toThrow(FatalError);
    await expect(
      run({ targetEnv: "all", invalidateKeys: true, init: "sentry" }),
    ).rejects.toThrow("already exist");
  });

  it("does not block --init firebase for production when Firebase key exists only on preview", async () => {
    await setupMocks();
    process.env.FIREBASE_SA_EMAIL = "sa@my-project.iam.gserviceaccount.com";
    process.env.GCLOUD_PROJECT = "my-project";
    const { VercelClient } = await import("../lib/vercel-api");
    vi.spyOn(VercelClient.prototype, "listEnvVars").mockResolvedValue({
      envs: [
        {
          id: "e1",
          key: "FIREBASE_SERVICE_ACCOUNT",
          value: "{}",
          target: ["preview"],
          type: "encrypted",
        },
      ],
      pagination: undefined,
    });

    // Guard passes — the preview-scoped key is invisible to the production check.
    // The run ultimately fails deeper (gcloud mock writes no key file), but the
    // error must not be the "already exist" guard.
    const error = await run({
      targetEnv: "production",
      invalidateKeys: true,
      init: "firebase",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("already exist");
  });

  it("throws FatalError when --init firebase and FIREBASE_SA_EMAIL is not set", async () => {
    await setupMocks();
    delete process.env.FIREBASE_SA_EMAIL;
    process.env.GCLOUD_PROJECT = "my-project";
    const { VercelClient } = await import("../lib/vercel-api");
    vi.spyOn(VercelClient.prototype, "listEnvVars").mockResolvedValue({
      envs: [],
      pagination: undefined,
    });

    await expect(
      run({ targetEnv: "production", invalidateKeys: true, init: "firebase" }),
    ).rejects.toThrow(FatalError);
    await expect(
      run({ targetEnv: "production", invalidateKeys: true, init: "firebase" }),
    ).rejects.toThrow("FIREBASE_SA_EMAIL");
  });

  it("throws FatalError when --init firebase and GCLOUD_PROJECT is not set", async () => {
    await setupMocks();
    process.env.FIREBASE_SA_EMAIL = "sa@project.iam.gserviceaccount.com";
    delete process.env.GCLOUD_PROJECT;
    const { VercelClient } = await import("../lib/vercel-api");
    vi.spyOn(VercelClient.prototype, "listEnvVars").mockResolvedValue({
      envs: [],
      pagination: undefined,
    });

    await expect(
      run({ targetEnv: "production", invalidateKeys: true, init: "firebase" }),
    ).rejects.toThrow(FatalError);
    await expect(
      run({ targetEnv: "production", invalidateKeys: true, init: "firebase" }),
    ).rejects.toThrow("GCLOUD_PROJECT");
  });

  it("throws FatalError when --init sentry and SENTRY_AUTH_TOKEN is not set", async () => {
    await setupMocks();
    delete process.env.SENTRY_AUTH_TOKEN;
    process.env.SENTRY_ORG = "my-org";
    process.env.SENTRY_PROJECT = "my-project";
    const { VercelClient } = await import("../lib/vercel-api");
    vi.spyOn(VercelClient.prototype, "listEnvVars").mockResolvedValue({
      envs: [],
      pagination: undefined,
    });

    await expect(
      run({ targetEnv: "production", invalidateKeys: true, init: "sentry" }),
    ).rejects.toThrow(FatalError);
    await expect(
      run({ targetEnv: "production", invalidateKeys: true, init: "sentry" }),
    ).rejects.toThrow("SENTRY_AUTH_TOKEN");
  });
});

// ─── run — --init happy paths ─────────────────────────────────────────────────

describe("run — --init happy paths", () => {
  let origEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    origEnv = { ...process.env };
    process.env.VERCEL_TOKEN = "test-token";
    process.env.VERCEL_PROJECT_ID = "prj_test";
    delete process.env.VERCEL_TEAM_ID;
  });

  afterEach(() => {
    process.env = origEnv;
    vi.restoreAllMocks();
  });

  it("--init firebase creates a GCP key, pushes FIREBASE_SERVICE_ACCOUNT once (not per-iteration), and triggers a redeployment", async () => {
    process.env.FIREBASE_SA_EMAIL = "sa@my-project.iam.gserviceaccount.com";
    process.env.GCLOUD_PROJECT = "my-project";

    const subprocess = await import("../lib/subprocess");
    vi.spyOn(subprocess, "commandExists").mockReturnValue(true);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    // Mock subprocess.run: when gcloud creates a key, write a fake SA key file
    const fakeKey = {
      private_key_id: "key-abc",
      private_key:
        "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
      client_email: "sa@my-project.iam.gserviceaccount.com",
    };
    vi.spyOn(subprocess, "run").mockImplementation((cmd, args) => {
      if (
        cmd === "gcloud" &&
        Array.isArray(args) &&
        args.includes("create") &&
        args.includes("keys")
      ) {
        const outputFile = args[args.indexOf("create") + 1];
        fs.writeFileSync(outputFile, JSON.stringify(fakeKey));
      }
      return "rmartz";
    });

    const { VercelClient } = await import("../lib/vercel-api");
    const listEnvVarsMock = vi
      .spyOn(VercelClient.prototype, "listEnvVars")
      .mockResolvedValue({ envs: [], pagination: undefined });
    const setEnvMock = vi
      .spyOn(VercelClient.prototype, "setEnvForTarget")
      .mockResolvedValue(undefined);
    vi.spyOn(VercelClient.prototype, "getLatestDeployment").mockResolvedValue({
      uid: "dep_1",
      url: "my-project.vercel.app",
      name: "my-project",
    });
    vi.spyOn(VercelClient.prototype, "triggerRedeployment").mockResolvedValue(
      "dep_2",
    );
    vi.spyOn(VercelClient.prototype, "pollDeploymentStatus").mockResolvedValue(
      undefined,
    );

    await run({
      targetEnv: "production",
      invalidateKeys: true,
      init: "firebase",
    });

    // listEnvVars should be called exactly twice: once in run() for the guard
    // check, and once in initFirebase before the loop (not once per iteration)
    expect(listEnvVarsMock).toHaveBeenCalledTimes(2);

    // setEnvForTarget should be called once for the single targeted env
    expect(setEnvMock).toHaveBeenCalledOnce();
    expect(setEnvMock).toHaveBeenCalledWith(
      "FIREBASE_SERVICE_ACCOUNT",
      expect.stringContaining("key-abc"),
      "production",
      expect.any(Array),
    );

    // A redeployment should have been triggered
    expect(
      vi.mocked(VercelClient.prototype.triggerRedeployment),
    ).toHaveBeenCalled();
  });

  it("--init sentry creates a Sentry key, pushes NEXT_PUBLIC_SENTRY_DSN once (not per-iteration), and triggers a redeployment", async () => {
    process.env.SENTRY_AUTH_TOKEN = "sntryu_token";
    process.env.SENTRY_ORG = "my-org";
    process.env.SENTRY_PROJECT = "my-project";

    const subprocess = await import("../lib/subprocess");
    vi.spyOn(subprocess, "commandExists").mockReturnValue(true);
    vi.spyOn(subprocess, "run").mockReturnValue("rmartz");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { VercelClient } = await import("../lib/vercel-api");
    const listEnvVarsMock = vi
      .spyOn(VercelClient.prototype, "listEnvVars")
      .mockResolvedValue({ envs: [], pagination: undefined });
    const setEnvMock = vi
      .spyOn(VercelClient.prototype, "setEnvForTarget")
      .mockResolvedValue(undefined);
    vi.spyOn(VercelClient.prototype, "getLatestDeployment").mockResolvedValue({
      uid: "dep_1",
      url: "my-project.vercel.app",
      name: "my-project",
    });
    vi.spyOn(VercelClient.prototype, "triggerRedeployment").mockResolvedValue(
      "dep_2",
    );
    vi.spyOn(VercelClient.prototype, "pollDeploymentStatus").mockResolvedValue(
      undefined,
    );

    // Mock global fetch for Sentry API call
    const fakeDsn = "https://abc123@o0.ingest.sentry.io/1";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: "sentry-key-1", dsn: { public: fakeDsn } }),
        text: async () => "",
      }),
    );

    await run({
      targetEnv: "production",
      invalidateKeys: true,
      init: "sentry",
    });

    // listEnvVars should be called exactly once (not once per target env)
    // The first call is in run() to check for existing keys; the second is in initSentry
    expect(listEnvVarsMock).toHaveBeenCalledTimes(2);

    // setEnvForTarget should be called once for the single targeted env
    expect(setEnvMock).toHaveBeenCalledOnce();
    expect(setEnvMock).toHaveBeenCalledWith(
      "NEXT_PUBLIC_SENTRY_DSN",
      fakeDsn,
      "production",
      expect.any(Array),
    );

    // A redeployment should have been triggered
    expect(
      vi.mocked(VercelClient.prototype.triggerRedeployment),
    ).toHaveBeenCalled();
  });
});
