import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { githubAuthState } from "../lib/auth";
import {
  checkGithubSecrets,
  resolveGithubSecrets,
  withGithubSecretSync,
} from "../lib/github-secrets";
import type { DeploymentProvider } from "../lib/providers/deployment";
import { assertProviderAuth } from "../lib/rotation-preflight";
import * as subprocess from "../lib/subprocess";
import { makeManifestDir } from "./fixtures";

let tmpDir: string;

const MANIFEST = [
  "environments: [production, staging]",
  "deployments:",
  "  - provider: vercel",
  "    targets:",
  "      production: production",
  "      staging: preview",
  "github:",
  "  repo: acme/app",
  "  secrets:",
  "    - variable: FIREBASE_PRIVATE_KEY",
  "      environment: staging",
  "      name: STAGING_FIREBASE_PRIVATE_KEY",
  "      githubEnvironment: e2e",
  "    - variable: CRON_SECRET",
  "      environment: production",
];

// A deployment provider whose only meaningful member is setEnvForTarget — the
// write path every secret goes through.
function makeDeployment(): DeploymentProvider & { writes: string[] } {
  const writes: string[] = [];
  const unused = () => Promise.reject(new Error("unused"));
  return {
    provider: "vercel",
    projectId: "prj_test",
    teamId: undefined,
    writes,
    listEnvVars: unused,
    getEnvVarValue: unused,
    findEnvVar: () => undefined,
    createEnvVar: unused,
    updateEnvVar: unused,
    setEnvForTarget: (key, _value, target) => {
      writes.push(`${key}@${target}`);
      return Promise.resolve(`${key}-id`);
    },
    removeEnvVarFromTarget: unused,
    triggerAndWaitRedeployments: unused,
    refreshPreviewDeployments: unused,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "github-secrets-"));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("resolveGithubSecrets — manifest declaration", () => {
  it("maps each declared secret's environment to its provider target", () => {
    const dir = makeManifestDir(tmpDir, MANIFEST);
    expect(resolveGithubSecrets(dir)).toEqual([
      {
        variable: "FIREBASE_PRIVATE_KEY",
        target: "preview",
        secretName: "STAGING_FIREBASE_PRIVATE_KEY",
        githubEnvironment: "e2e",
        repo: "acme/app",
      },
      {
        variable: "CRON_SECRET",
        target: "production",
        secretName: "CRON_SECRET",
        githubEnvironment: undefined,
        repo: "acme/app",
      },
    ]);
  });

  it("is empty when the manifest declares no github block", () => {
    const dir = makeManifestDir(tmpDir, MANIFEST.slice(0, 6));
    expect(resolveGithubSecrets(dir)).toEqual([]);
  });

  it("skips an entry missing its variable or environment", () => {
    const dir = makeManifestDir(tmpDir, [
      "environments: [production]",
      "github:",
      "  secrets:",
      "    - variable: ORPHAN",
      "    - environment: production",
    ]);
    expect(resolveGithubSecrets(dir)).toEqual([]);
  });
});

describe("withGithubSecretSync — mirrors pushed values to GitHub", () => {
  it("writes a matching value to the declared secret via stdin", async () => {
    const runSpy = vi.spyOn(subprocess, "run").mockReturnValue("");
    const dir = makeManifestDir(tmpDir, MANIFEST);
    const synced = withGithubSecretSync(
      makeDeployment(),
      resolveGithubSecrets(dir),
    );

    await synced.setEnvForTarget(
      "FIREBASE_PRIVATE_KEY",
      "pk-new",
      "preview",
      [],
    );

    expect(runSpy).toHaveBeenCalledWith(
      "gh",
      [
        "secret",
        "set",
        "STAGING_FIREBASE_PRIVATE_KEY",
        "--repo",
        "acme/app",
        "--env",
        "e2e",
      ],
      { input: "pk-new" },
    );
  });

  it("still writes the deployment provider first", async () => {
    vi.spyOn(subprocess, "run").mockReturnValue("");
    const inner = makeDeployment();
    const synced = withGithubSecretSync(
      inner,
      resolveGithubSecrets(makeManifestDir(tmpDir, MANIFEST)),
    );

    await synced.setEnvForTarget("CRON_SECRET", "c", "production", []);

    expect(inner.writes).toEqual(["CRON_SECRET@production"]);
  });

  it("does not mirror the same variable on an undeclared target", async () => {
    const runSpy = vi.spyOn(subprocess, "run").mockReturnValue("");
    const synced = withGithubSecretSync(
      makeDeployment(),
      resolveGithubSecrets(makeManifestDir(tmpDir, MANIFEST)),
    );

    await synced.setEnvForTarget(
      "FIREBASE_PRIVATE_KEY",
      "pk",
      "production",
      [],
    );

    expect(runSpy).not.toHaveBeenCalled();
  });

  it("rejects when the GitHub write fails, so the run aborts", async () => {
    vi.spyOn(subprocess, "run").mockImplementation(() => {
      throw new Error("gh exited with code 1: HTTP 403");
    });
    const synced = withGithubSecretSync(
      makeDeployment(),
      resolveGithubSecrets(makeManifestDir(tmpDir, MANIFEST)),
    );

    await expect(
      synced.setEnvForTarget("CRON_SECRET", "c", "production", []),
    ).rejects.toThrow(/CRON_SECRET/);
  });
});

describe("githubAuthState / preflight — gh auth", () => {
  it("reports GH_TOKEN as the source when set", () => {
    vi.stubEnv("GH_TOKEN", "ghp_test");
    expect(githubAuthState()).toEqual({
      authenticated: true,
      source: "GH_TOKEN env var",
    });
  });

  it("is unauthenticated when no token is set and gh is absent", () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.spyOn(subprocess, "commandExists").mockReturnValue(false);
    expect(githubAuthState().authenticated).toBe(false);
  });

  it("fails the preflight when GitHub secrets are targeted but gh is unauthenticated", () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.spyOn(subprocess, "commandExists").mockReturnValue(false);
    expect(() =>
      assertProviderAuth({ firebase: false, sentry: false, github: true }),
    ).toThrow(/github/);
  });
});

describe("run — GitHub preflight wiring", () => {
  it("fails before minting when a declared GitHub target is unauthenticated", async () => {
    vi.stubEnv("VERCEL_TOKEN", "test-token");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_test");
    vi.stubEnv("VERCEL_TEAM_ID", "");
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(subprocess, "commandExists").mockImplementation(
      (cmd) => cmd !== "gh",
    );
    vi.spyOn(subprocess, "run").mockReturnValue("rmartz");
    const { VercelClient } = await import("../lib/vercel-api");
    vi.spyOn(VercelClient.prototype, "listEnvVars").mockResolvedValue({
      envs: [
        {
          id: "e1",
          key: "FIREBASE_PRIVATE_KEY",
          value: "pk",
          target: ["preview"],
          type: "encrypted",
        },
      ],
      pagination: undefined,
    });
    const firebase = await import("../lib/firebase");
    const rotateSpy = vi
      .spyOn(firebase, "rotateFirebase")
      .mockResolvedValue({ oldKeys: [], fp: null });
    const { run } = await import("../lib/rotation");

    await expect(
      run({
        targetEnv: "preview",
        invalidateKeys: true,
        workingDir: tmpDir,
        deploymentDir: makeManifestDir(tmpDir, MANIFEST),
      }),
    ).rejects.toThrow(/github/);
    expect(rotateSpy).not.toHaveBeenCalled();
  });
});

describe("checkGithubSecrets — presence of declared secrets", () => {
  it("errors on a declared secret absent from its repo/environment", () => {
    vi.spyOn(subprocess, "run").mockImplementation((_cmd, args) =>
      args.includes("--env")
        ? JSON.stringify([{ name: "OTHER" }])
        : JSON.stringify([{ name: "CRON_SECRET" }]),
    );
    const found = checkGithubSecrets(
      resolveGithubSecrets(makeManifestDir(tmpDir, MANIFEST)),
    );
    expect(found).toEqual([
      expect.objectContaining({
        severity: "error",
        kind: "github-missing",
        key: "STAGING_FIREBASE_PRIVATE_KEY",
      }),
    ]);
  });

  it("warns instead of erroring when the secrets cannot be listed", () => {
    vi.spyOn(subprocess, "run").mockImplementation(() => {
      throw new Error("gh exited with code 4: not logged in");
    });
    const found = checkGithubSecrets(
      resolveGithubSecrets(makeManifestDir(tmpDir, MANIFEST)),
    );
    expect(found.every((f) => f.severity === "warning")).toBe(true);
  });
});
