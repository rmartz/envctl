import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as deployments from "../lib/deployments";
import * as rotation from "../lib/rotation";
import { runSecrets, type SecretsOptions } from "../lib/commands/secrets";
import { FatalError } from "../lib/logger";
import { makeDeploymentDir } from "./fixtures";

let tmpDir: string;
let origEnv: NodeJS.ProcessEnv;
let runSpy: ReturnType<typeof vi.spyOn>;
let refreshSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-test-"));
  origEnv = { ...process.env };
  process.env.VERCEL_TOKEN = "test-token";
  process.env.VERCEL_PROJECT_ID = "prj_test";
  delete process.env.VERCEL_TEAM_ID;
  // Point the Vercel CLI auth lookup at a nonexistent file so resolveVercelToken
  // never falls back to a real `vercel login` on the host running the suite.
  process.env.__VERCEL_CLI_AUTH_PATH = path.join(tmpDir, "no-vercel-auth.json");
  // Clear provider config env so the deployment YAML is the only source.
  for (const k of [
    "FIREBASE_SA_EMAIL",
    "GCLOUD_PROJECT",
    "SENTRY_ORG",
    "SENTRY_PROJECT",
  ])
    delete process.env[k];
  runSpy = vi.spyOn(rotation, "run").mockResolvedValue(undefined);
  refreshSpy = vi
    .spyOn(deployments, "refreshPreviewDeployments")
    .mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  process.env = origEnv;
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeOpts(
  deploymentDir: string,
  over: Partial<SecretsOptions> = {},
): SecretsOptions {
  return {
    targetEnv: "all",
    workingDir: tmpDir,
    deploymentDir,
    invalidateKeys: true,
    refreshPreviews: false,
    init: undefined,
    ...over,
  };
}

const FIREBASE_VARS = {
  FIREBASE_SA_EMAIL: "sa@proj.iam.gserviceaccount.com",
  FIREBASE_PROJECT_ID: "gcp-proj",
};
const SENTRY_VARS = { SENTRY_ORG: "acme", SENTRY_PROJECT: "web" };

// ─── Criterion 1: rotate dispatches the engine per environment ─────────────────

describe("runSecrets — rotate", () => {
  it("rotates --env all through a single engine call, sourcing config from YAML", async () => {
    const dir = makeDeploymentDir(tmpDir, ["production"], {
      production: SENTRY_VARS,
    });
    await runSecrets(makeOpts(dir));
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        targetEnv: "all",
        invalidateKeys: true,
        workingDir: tmpDir,
        init: undefined,
        sentryOrg: "acme",
        sentryProject: "web",
      }),
    );
  });

  it("maps a named --env to its Vercel target", async () => {
    const dir = makeDeploymentDir(tmpDir, ["staging"], {
      staging: SENTRY_VARS,
    });
    await runSecrets(makeOpts(dir, { targetEnv: "staging" }));
    expect(runSpy).toHaveBeenCalledWith(
      expect.objectContaining({ targetEnv: "preview" }),
    );
  });
});

// ─── Criterion 2: --no-invalidate / --refresh-previews ─────────────────────────

describe("runSecrets — invalidate & preview flags", () => {
  it("--no-invalidate passes invalidateKeys: false to the engine", async () => {
    const dir = makeDeploymentDir(tmpDir, ["production"], {
      production: SENTRY_VARS,
    });
    await runSecrets(makeOpts(dir, { invalidateKeys: false }));
    expect(runSpy).toHaveBeenCalledWith(
      expect.objectContaining({ invalidateKeys: false }),
    );
  });

  it("--refresh-previews refreshes previews once after rotation", async () => {
    const dir = makeDeploymentDir(tmpDir, ["production"], {
      production: SENTRY_VARS,
    });
    await runSecrets(makeOpts(dir, { refreshPreviews: true }));
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it("does not refresh previews by default", async () => {
    const dir = makeDeploymentDir(tmpDir, ["production"], {
      production: SENTRY_VARS,
    });
    await runSecrets(makeOpts(dir));
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});

// ─── Criterion 3: init bootstraps (per-service, auto-detect) ───────────────────

describe("runSecrets — init", () => {
  it("init firebase --env all rotates Firebase per target plus development", async () => {
    const dir = makeDeploymentDir(tmpDir, ["staging", "production"], {
      staging: FIREBASE_VARS,
      production: FIREBASE_VARS,
    });
    await runSecrets(makeOpts(dir, { init: "firebase" }));
    expect(runSpy).toHaveBeenCalledTimes(3);
    expect(runSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ targetEnv: "preview", init: "firebase" }),
    );
    expect(runSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ targetEnv: "production", init: "firebase" }),
    );
    expect(runSpy).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ targetEnv: "development", init: "firebase" }),
    );
  });

  it("init sentry --env all rotates Sentry once, project-wide", async () => {
    const dir = makeDeploymentDir(tmpDir, ["staging", "production"], {
      staging: SENTRY_VARS,
      production: SENTRY_VARS,
    });
    await runSecrets(makeOpts(dir, { init: "sentry" }));
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledWith(
      expect.objectContaining({ targetEnv: "all", init: "sentry" }),
    );
  });

  it("init auto detects the service from the deployment config", async () => {
    const dir = makeDeploymentDir(tmpDir, ["staging"], {
      staging: SENTRY_VARS,
    });
    await runSecrets(makeOpts(dir, { init: "auto" }));
    expect(runSpy).toHaveBeenCalledWith(
      expect.objectContaining({ init: "sentry" }),
    );
  });

  it("init firebase --env production runs a single per-env call", async () => {
    const dir = makeDeploymentDir(tmpDir, ["production"], {
      production: FIREBASE_VARS,
    });
    await runSecrets(
      makeOpts(dir, { init: "firebase", targetEnv: "production" }),
    );
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledWith(
      expect.objectContaining({ targetEnv: "production", init: "firebase" }),
    );
  });
});

// ─── Criterion 4: fail early on missing prerequisites / config ─────────────────

describe("runSecrets — early failures", () => {
  it("errors when no Vercel token is available", async () => {
    delete process.env.VERCEL_TOKEN;
    const dir = makeDeploymentDir(tmpDir, ["production"], {
      production: SENTRY_VARS,
    });
    await expect(runSecrets(makeOpts(dir))).rejects.toThrow(FatalError);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("errors when the deployment directory is missing", async () => {
    await expect(
      runSecrets(makeOpts(path.join(tmpDir, "nope"))),
    ).rejects.toThrow(FatalError);
  });

  it("errors when environments.yml is missing", async () => {
    const empty = path.join(tmpDir, "empty");
    fs.mkdirSync(empty);
    await expect(runSecrets(makeOpts(empty))).rejects.toThrow(FatalError);
  });

  it("errors when --env names an inactive environment", async () => {
    const dir = makeDeploymentDir(tmpDir, ["production"], {
      production: SENTRY_VARS,
    });
    await expect(
      runSecrets(makeOpts(dir, { targetEnv: "staging" })),
    ).rejects.toThrow(FatalError);
  });

  it("errors when init config is missing from the deployment YAML", async () => {
    const dir = makeDeploymentDir(tmpDir, ["production"], {
      production: { NEXT_PUBLIC_FIREBASE_PROJECT_ID: "x" },
    });
    await expect(
      runSecrets(makeOpts(dir, { init: "firebase" })),
    ).rejects.toThrow(FatalError);
    expect(runSpy).not.toHaveBeenCalled();
  });
});
