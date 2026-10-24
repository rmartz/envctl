import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  githubAppKeyFingerprint,
  readGithubAppPrivateKey,
} from "../lib/github-app";
import { run } from "../lib/rotation";
import { makeGithubAppKeyFile } from "./fixtures";

// The github-app provider (#201) through the rotation engine: secrets land in
// Vercel as sensitive vars, and GitHub's webhook config is PATCHed only after
// the redeploy is READY — so any earlier failure leaves GitHub untouched.
describe("run — github-app provider", () => {
  let origEnv: NodeJS.ProcessEnv;
  let tmpDir: string;
  let deployDir: string;
  let keyFile: string;
  let events: string[];
  let patchedSecrets: string[];
  let pushedValues: Record<string, string>;

  beforeEach(() => {
    origEnv = { ...process.env };
    process.env.VERCEL_TOKEN = "test-token";
    process.env.VERCEL_PROJECT_ID = "prj_test";
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.GITHUB_API_URL;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rotate-gh-app-"));
    deployDir = path.join(tmpDir, "deployment");
    fs.mkdirSync(deployDir);
    writeConfig("APP_CLIENT_ID: Iv1.test\n");
    keyFile = makeGithubAppKeyFile(tmpDir);
    events = [];
    patchedSecrets = [];
    pushedValues = {};
  });

  afterEach(() => {
    process.env = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeConfig(productionYaml: string) {
    fs.writeFileSync(
      path.join(deployDir, "manifest.yml"),
      [
        "environments: [production]",
        "services:",
        "  - provider: github-app",
        "    environments: [production]",
        "    webhookUrl: https://app.example.com/api/webhook",
        "    variables:",
        "      clientId: APP_CLIENT_ID",
        "      privateKey: APP_PRIVATE_KEY",
        "      webhookSecret: APP_WEBHOOK_SECRET",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(deployDir, "production.yml"), productionYaml);
  }

  // Mock Vercel (with `keys` live on production) and GitHub, recording the
  // order of the hook-config GET preflight, pushes, the redeploy, and the
  // webhook PATCH in `events`. `hookStatus` is GitHub's hook-config status.
  async function mockServices(
    keys: string[],
    redeployFails = false,
    hookStatus = 200,
    appStatus = 200,
  ) {
    const subprocess = await import("../lib/subprocess");
    vi.spyOn(subprocess, "commandExists").mockReturnValue(true);
    vi.spyOn(subprocess, "run").mockReturnValue("rmartz");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { VercelClient } = await import("../lib/vercel-api");
    vi.spyOn(VercelClient.prototype, "listEnvVars").mockResolvedValue({
      envs: keys.map((key, i) => ({
        id: `k${i}`,
        key,
        value: "",
        target: ["production"],
        type: "sensitive" as const,
      })),
      pagination: undefined,
    });
    vi.spyOn(VercelClient.prototype, "setEnvForTarget").mockImplementation(
      (key, value, target, _envs, type) => {
        events.push(`push ${key} ${target} ${type}`);
        pushedValues[key] = value;
        return Promise.resolve(`id-${key}`);
      },
    );
    const deployments = await import("../lib/deployments");
    vi.spyOn(deployments, "triggerAndWaitRedeployments").mockImplementation(
      () => {
        events.push("redeploy");
        return redeployFails
          ? Promise.reject(new Error("deployment ERROR"))
          : Promise.resolve();
      },
    );
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      if (init?.method === "PATCH") {
        events.push("patch");
        const body = JSON.parse(init.body as string) as { secret: string };
        patchedSecrets.push(body.secret);
      } else if ((url as string).endsWith("/app")) {
        events.push("get app");
        return Promise.resolve(new Response("{}", { status: appStatus }));
      } else {
        events.push("get hook");
      }
      return Promise.resolve(new Response("{}", { status: hookStatus }));
    });
  }

  const opts = (extra: object) => ({
    targetEnv: "all",
    invalidateKeys: true,
    workingDir: tmpDir,
    deploymentDir: deployDir,
    githubAppPrivateKeyFile: keyFile,
    ...extra,
  });

  describe("init", () => {
    it("pushes both secrets as sensitive vars, then PATCHes after the redeploy", async () => {
      await mockServices([]);
      await run(opts({ init: "github-app" }));
      expect(events).toEqual([
        "get hook",
        "push APP_PRIVATE_KEY production sensitive",
        "push APP_WEBHOOK_SECRET production sensitive",
        "redeploy",
        "get app",
        "patch",
      ]);
    });

    it("gives GitHub the same webhook secret it pushed to Vercel", async () => {
      await mockServices([]);
      await run(opts({ init: "github-app" }));
      expect(patchedSecrets).toEqual([pushedValues.APP_WEBHOOK_SECRET]);
    });

    it("pushes the PEM file's key as the private key var", async () => {
      await mockServices([]);
      await run(opts({ init: "github-app" }));
      expect(pushedValues.APP_PRIVATE_KEY).toBe(
        `${fs.readFileSync(keyFile, "utf-8").trim()}\n`,
      );
    });

    it("never writes key material to the console", async () => {
      await mockServices([]);
      await run(opts({ init: "github-app" }));
      const output = [
        ...vi.mocked(console.log).mock.calls,
        ...vi.mocked(console.error).mock.calls,
      ].join("\n");
      expect(output).not.toContain("PRIVATE KEY-----");
    });

    it("errors on a replay when the secret already exists", async () => {
      await mockServices(["APP_WEBHOOK_SECRET"]);
      await expect(run(opts({ init: "github-app" }))).rejects.toThrow(
        /GitHub App keys already exist/,
      );
    });
  });

  describe("rotate", () => {
    it("pushes the key file and a new secret, redeploys, proves the key, then PATCHes", async () => {
      await mockServices(["APP_PRIVATE_KEY", "APP_WEBHOOK_SECRET"]);
      await run(opts({ provider: "github-app" }));
      expect(events).toEqual([
        "get hook",
        "push APP_PRIVATE_KEY production sensitive",
        "push APP_WEBHOOK_SECRET production sensitive",
        "redeploy",
        "get app",
        "patch",
      ]);
    });

    it("pushes both where only the private key exists", async () => {
      await mockServices(["APP_PRIVATE_KEY"]);
      await run(opts({ provider: "github-app" }));
      expect(events).toEqual([
        "get hook",
        "push APP_PRIVATE_KEY production sensitive",
        "push APP_WEBHOOK_SECRET production sensitive",
        "redeploy",
        "get app",
        "patch",
      ]);
    });

    it("leaves GitHub untouched when the redeploy fails", async () => {
      await mockServices(["APP_PRIVATE_KEY", "APP_WEBHOOK_SECRET"], true);
      await expect(run(opts({ provider: "github-app" }))).rejects.toThrow(
        /deployment ERROR/,
      );
      expect(events).not.toContain("patch");
    });

    it("still PATCHes under --no-invalidate", async () => {
      await mockServices(["APP_PRIVATE_KEY", "APP_WEBHOOK_SECRET"]);
      await run(opts({ provider: "github-app", invalidateKeys: false }));
      expect(events).toContain("patch");
    });

    it("mints a distinct secret on each rotation", async () => {
      await mockServices(["APP_PRIVATE_KEY", "APP_WEBHOOK_SECRET"]);
      await run(opts({ provider: "github-app" }));
      await run(opts({ provider: "github-app" }));
      expect(new Set(patchedSecrets).size).toBe(2);
    });

    it("reports the proven key's fingerprint after the PATCH", async () => {
      await mockServices(["APP_PRIVATE_KEY", "APP_WEBHOOK_SECRET"]);
      await run(opts({ provider: "github-app" }));
      const { key } = readGithubAppPrivateKey(keyFile);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining(
          `is now the App key ${githubAppKeyFingerprint(key)}`,
        ),
      );
    });

    it("leaves GitHub untouched when the key fails GET /app", async () => {
      await mockServices(
        ["APP_PRIVATE_KEY", "APP_WEBHOOK_SECRET"],
        false,
        200,
        401,
      );
      await expect(run(opts({ provider: "github-app" }))).rejects.toThrow(
        /rejected the App JWT/,
      );
      expect(events).not.toContain("patch");
    });
  });

  describe("preflight", () => {
    it("fails before any push when --private-key-file is missing", async () => {
      await mockServices([]);
      await expect(
        run(opts({ init: "github-app", githubAppPrivateKeyFile: undefined })),
      ).rejects.toThrow(/pass --private-key-file/);
      expect(events).toEqual([]);
    });

    it("fails before any push when the PEM is invalid", async () => {
      const bad = path.join(tmpDir, "bad.pem");
      fs.writeFileSync(bad, "garbage");
      await mockServices(["APP_PRIVATE_KEY", "APP_WEBHOOK_SECRET"]);
      await expect(
        run(opts({ provider: "github-app", githubAppPrivateKeyFile: bad })),
      ).rejects.toThrow(/not a valid PEM/);
      expect(events).toEqual([]);
    });

    it("fails before any push when the Client ID is not configured", async () => {
      writeConfig("OTHER: x\n");
      await mockServices([]);
      await expect(run(opts({ init: "github-app" }))).rejects.toThrow(
        /set APP_CLIENT_ID/,
      );
      expect(events).toEqual([]);
    });

    it("fails before any push when the App's webhook is inactive", async () => {
      await mockServices([], false, 404);
      await expect(run(opts({ init: "github-app" }))).rejects.toThrow(
        /webhook is not active/,
      );
      expect(events).toEqual(["get hook"]);
    });
  });
});
