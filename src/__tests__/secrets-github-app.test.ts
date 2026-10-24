import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as rotation from "../lib/rotation";
import { runSecrets, type SecretsOptions } from "../lib/commands/secrets";
import { makeDeploymentDir } from "./fixtures";

// `secrets init` dispatch for the github-app provider (#201): auto-detection
// from a declared service, and one engine call for the App's single webhook.
let tmpDir: string;
let origEnv: NodeJS.ProcessEnv;
let runSpy: ReturnType<typeof vi.spyOn<typeof rotation, "run">>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-gh-app-"));
  origEnv = { ...process.env };
  process.env.VERCEL_TOKEN = "test-token";
  process.env.VERCEL_PROJECT_ID = "prj_test";
  delete process.env.VERCEL_TEAM_ID;
  process.env.__VERCEL_CLI_AUTH_PATH = path.join(tmpDir, "no-vercel-auth.json");
  for (const k of ["SENTRY_ORG", "SENTRY_PROJECT"]) delete process.env[k];
  runSpy = vi.spyOn(rotation, "run").mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  process.env = origEnv;
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// A legacy-format deployment dir plus a manifest declaring a github-app service.
function makeGithubAppDir(production: Record<string, string>): string {
  const dir = makeDeploymentDir(tmpDir, ["production"], { production });
  fs.writeFileSync(
    path.join(dir, "manifest.yml"),
    "services:\n  - provider: github-app\n    webhookUrl: https://x.test/api/webhook\n",
  );
  return dir;
}

const makeOpts = (
  deploymentDir: string,
  over: Partial<SecretsOptions>,
): SecretsOptions => ({
  targetEnv: "all",
  workingDir: tmpDir,
  deploymentDir,
  invalidateKeys: true,
  refreshPreviews: false,
  ...over,
});

describe("runSecrets — github-app init", () => {
  it("auto-detects a declared github-app service", async () => {
    const dir = makeGithubAppDir({ GITHUB_APP_CLIENT_ID: "Iv1.x" });
    await runSecrets(makeOpts(dir, { init: "auto" }));
    expect(runSpy).toHaveBeenCalledWith(
      expect.objectContaining({ init: "github-app" }),
    );
  });

  it("refuses auto-detection when Sentry is configured too", async () => {
    const dir = makeGithubAppDir({ SENTRY_ORG: "acme", SENTRY_PROJECT: "web" });
    await expect(runSecrets(makeOpts(dir, { init: "auto" }))).rejects.toThrow(
      /initialize each by name/,
    );
  });

  it("initializes --env all in one engine call, passing the PEM path", async () => {
    const dir = makeGithubAppDir({ GITHUB_APP_CLIENT_ID: "Iv1.x" });
    await runSecrets(
      makeOpts(dir, {
        init: "github-app",
        githubAppPrivateKeyFile: "/keys/app.pem",
      }),
    );
    expect(runSpy.mock.calls).toEqual([
      [
        expect.objectContaining({
          targetEnv: "all",
          init: "github-app",
          githubAppPrivateKeyFile: "/keys/app.pem",
        }),
      ],
    ]);
  });
});
