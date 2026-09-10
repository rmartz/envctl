import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as configPush from "../lib/commands/config-push";
import * as envPull from "../lib/commands/env-pull";
import * as secrets from "../lib/commands/secrets";
import { runBootstrap, runBootstrapCommand } from "../lib/commands/bootstrap";
import type { BootstrapOptions } from "../lib/commands/bootstrap-args";
import { FatalError } from "../lib/logger";
import * as subprocess from "../lib/subprocess";
import { VercelClient } from "../lib/vercel-api";
import { makeDeploymentDir } from "./fixtures";

let tmpDir: string;
let origEnv: NodeJS.ProcessEnv;
let pushSpy: ReturnType<typeof vi.spyOn>;
let secretsSpy: ReturnType<typeof vi.spyOn>;
let pullSpy: ReturnType<typeof vi.spyOn>;
let listSpy: ReturnType<typeof vi.spyOn>;

const FIREBASE_VARS = {
  FIREBASE_SA_EMAIL: "sa@proj.iam.gserviceaccount.com",
  FIREBASE_PROJECT_ID: "gcp-proj",
};
const SENTRY_VARS = { SENTRY_ORG: "acme", SENTRY_PROJECT: "web" };

function envRecords(keys: string[]) {
  return {
    envs: keys.map((key) => ({
      id: `id-${key}`,
      key,
      value: "x",
      target: ["production"],
      type: "encrypted" as const,
    })),
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-test-"));
  origEnv = { ...process.env };
  process.env.VERCEL_TOKEN = "test-token";
  process.env.VERCEL_PROJECT_ID = "prj_test";
  process.env.SENTRY_AUTH_TOKEN = "sentry-token";
  delete process.env.VERCEL_TEAM_ID;
  // Point CLI credential lookups at nonexistent files so nothing falls back to
  // a real login on the host running the suite.
  process.env.__VERCEL_CLI_AUTH_PATH = path.join(tmpDir, "no-vercel-auth.json");
  process.env.__SENTRY_CLIRC_PATH = path.join(tmpDir, "no-sentryclirc");
  for (const k of [
    "FIREBASE_SA_EMAIL",
    "GCLOUD_PROJECT",
    "SENTRY_ORG",
    "SENTRY_PROJECT",
  ])
    delete process.env[k];

  pushSpy = vi.spyOn(configPush, "runPush").mockResolvedValue(undefined);
  secretsSpy = vi.spyOn(secrets, "runSecrets").mockResolvedValue(undefined);
  pullSpy = vi.spyOn(envPull, "runEnvPull").mockReturnValue(undefined);
  listSpy = vi
    .spyOn(VercelClient.prototype, "listEnvVars")
    .mockResolvedValue(envRecords([]));
  // Every external tool the preflight probes is present by default.
  vi.spyOn(subprocess, "commandExists").mockReturnValue(true);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  process.env = origEnv;
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeOpts(
  deploymentDir: string,
  over: Partial<BootstrapOptions> = {},
): BootstrapOptions {
  return {
    targetEnv: "all",
    workingDir: tmpDir,
    deploymentDir,
    dryRun: false,
    pull: true,
    out: path.join(tmpDir, ".env.local"),
    ...over,
  };
}

// ─── Phase sequencing on a blank project ───────────────────────────────────────

describe("runBootstrap — blank project", () => {
  it("runs all three phases: push, init each configured secret, then pull", async () => {
    const dir = makeDeploymentDir(tmpDir, ["staging", "production"], {
      staging: { ...FIREBASE_VARS, ...SENTRY_VARS },
      production: { ...FIREBASE_VARS, ...SENTRY_VARS },
    });

    await runBootstrap(makeOpts(dir));

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        targetEnv: "all",
        deploymentDir: dir,
        dryRun: false,
      }),
    );
    expect(secretsSpy).toHaveBeenCalledTimes(2);
    expect(secretsSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ init: "firebase", targetEnv: "all" }),
    );
    expect(secretsSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ init: "sentry", targetEnv: "all" }),
    );
    expect(pullSpy).toHaveBeenCalledWith({ workingDir: tmpDir }, [
      "--env",
      "development",
      "--out",
      path.join(tmpDir, ".env.local"),
    ]);
  });

  it("passes a named --env through to the push and secrets phases", async () => {
    const dir = makeDeploymentDir(tmpDir, ["production"], {
      production: SENTRY_VARS,
    });

    await runBootstrap(makeOpts(dir, { targetEnv: "production" }));

    expect(pushSpy).toHaveBeenCalledWith(
      expect.objectContaining({ targetEnv: "production" }),
    );
    expect(secretsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ init: "sentry", targetEnv: "production" }),
    );
  });
});

// ─── Idempotent re-runs ────────────────────────────────────────────────────────

describe("runBootstrap — idempotency", () => {
  it("initializes only the missing secret when one already exists", async () => {
    const dir = makeDeploymentDir(tmpDir, ["staging"], {
      staging: { ...FIREBASE_VARS, ...SENTRY_VARS },
    });
    vi.mocked(VercelClient.prototype.listEnvVars).mockResolvedValue(
      envRecords(["FIREBASE_SERVICE_ACCOUNT"]),
    );

    await runBootstrap(makeOpts(dir));

    expect(secretsSpy).toHaveBeenCalledTimes(1);
    expect(secretsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ init: "sentry" }),
    );
  });

  it("initializes no secrets when all are already present", async () => {
    const dir = makeDeploymentDir(tmpDir, ["staging"], {
      staging: { ...FIREBASE_VARS, ...SENTRY_VARS },
    });
    vi.mocked(VercelClient.prototype.listEnvVars).mockResolvedValue(
      envRecords(["FIREBASE_SERVICE_ACCOUNT", "SENTRY_DSN"]),
    );

    await runBootstrap(makeOpts(dir));

    expect(secretsSpy).not.toHaveBeenCalled();
    // The public-config and pull phases still run.
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pullSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── Phase gating ──────────────────────────────────────────────────────────────

describe("runBootstrap — phase gating", () => {
  it("skips the secrets phase entirely when no provider is configured", async () => {
    const dir = makeDeploymentDir(tmpDir, ["production"], {
      production: { NEXT_PUBLIC_EXAMPLE: "v" },
    });

    await runBootstrap(makeOpts(dir));

    expect(secretsSpy).not.toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pullSpy).toHaveBeenCalledTimes(1);
  });

  it("--no-pull skips the local dotenv phase", async () => {
    const dir = makeDeploymentDir(tmpDir, ["production"], {
      production: SENTRY_VARS,
    });

    await runBootstrap(makeOpts(dir, { pull: false }));

    expect(pullSpy).not.toHaveBeenCalled();
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it("--dry-run runs no mutations and makes no Vercel calls", async () => {
    const dir = makeDeploymentDir(tmpDir, ["staging"], {
      staging: { ...FIREBASE_VARS, ...SENTRY_VARS },
    });

    await runBootstrap(makeOpts(dir, { dryRun: true }));

    expect(pushSpy).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
    expect(secretsSpy).not.toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();
    expect(pullSpy).not.toHaveBeenCalled();
  });
});

// ─── Fail-fast preflight ───────────────────────────────────────────────────────

describe("runBootstrap — preflight", () => {
  it("errors before any phase when the Vercel token is missing", async () => {
    delete process.env.VERCEL_TOKEN;
    const dir = makeDeploymentDir(tmpDir, ["production"], {
      production: SENTRY_VARS,
    });

    await expect(runBootstrap(makeOpts(dir))).rejects.toThrow(FatalError);
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("errors when Firebase is configured but gcloud is absent", async () => {
    vi.mocked(subprocess.commandExists).mockImplementation(
      (cmd: string) => cmd !== "gcloud",
    );
    const dir = makeDeploymentDir(tmpDir, ["production"], {
      production: FIREBASE_VARS,
    });

    await expect(runBootstrap(makeOpts(dir))).rejects.toThrow(FatalError);
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("errors when Sentry is configured but no Sentry token resolves", async () => {
    delete process.env.SENTRY_AUTH_TOKEN;
    const dir = makeDeploymentDir(tmpDir, ["production"], {
      production: SENTRY_VARS,
    });

    await expect(runBootstrap(makeOpts(dir))).rejects.toThrow(FatalError);
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("errors when --env names an inactive environment", async () => {
    const dir = makeDeploymentDir(tmpDir, ["production"], {
      production: SENTRY_VARS,
    });

    await expect(
      runBootstrap(makeOpts(dir, { targetEnv: "staging" })),
    ).rejects.toThrow(FatalError);
    expect(pushSpy).not.toHaveBeenCalled();
  });
});

// ─── Command adapter ───────────────────────────────────────────────────────────

describe("runBootstrapCommand", () => {
  it("parses args and dispatches to the orchestrator", async () => {
    makeDeploymentDir(tmpDir, ["production"], { production: SENTRY_VARS });

    await runBootstrapCommand({ workingDir: tmpDir }, ["--no-pull"]);

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pullSpy).not.toHaveBeenCalled();
  });
});
