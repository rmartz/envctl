import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FatalError } from "../lib/logger";
import * as subprocess from "../lib/subprocess";
import { assertProviderAuth } from "../lib/rotation-preflight";
import { run } from "../lib/rotation";

// ─── assertProviderAuth — the fail-fast auth gate ─────────────────────────────

describe("assertProviderAuth", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "envctl-preflight-"));
    // Neutralize ambient Sentry credentials and config so state is deterministic.
    vi.stubEnv("SENTRY_AUTH_TOKEN", "");
    vi.stubEnv("__SENTRY_CLIRC_PATH", path.join(tmpDir, "no-clirc"));
    vi.stubEnv("SENTRY_ORG", "");
    vi.stubEnv("SENTRY_PROJECT", "");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("passes when no provider is selected", () => {
    expect(() =>
      assertProviderAuth({ firebase: false, sentry: false }),
    ).not.toThrow();
  });

  it("throws when Firebase is selected but gcloud is unauthenticated", () => {
    vi.spyOn(subprocess, "commandExists").mockReturnValue(false); // no gcloud
    expect(() => assertProviderAuth({ firebase: true, sentry: false })).toThrow(
      FatalError,
    );
  });

  it("throws when Sentry is selected but no token resolves", () => {
    vi.spyOn(subprocess, "commandExists").mockReturnValue(true);
    expect(() => assertProviderAuth({ firebase: false, sentry: true })).toThrow(
      /sentry/i,
    );
  });

  it("passes when every selected provider is authenticated and configured", () => {
    vi.spyOn(subprocess, "commandExists").mockReturnValue(true);
    vi.spyOn(subprocess, "run").mockReturnValue("me@example.com\n");
    vi.stubEnv("SENTRY_AUTH_TOKEN", "sntryu_token");
    expect(() =>
      assertProviderAuth({
        firebase: true,
        sentry: true,
        sentryOrg: "test-org",
        sentryProject: "test-proj",
      }),
    ).not.toThrow();
  });

  it("throws when Sentry is selected but SENTRY_ORG is missing", () => {
    vi.spyOn(subprocess, "commandExists").mockReturnValue(true);
    vi.stubEnv("SENTRY_AUTH_TOKEN", "sntryu_token");
    expect(() =>
      assertProviderAuth({
        firebase: false,
        sentry: true,
        sentryProject: "test-proj",
      }),
    ).toThrow(/SENTRY_ORG/);
  });

  it("throws when Sentry is selected but SENTRY_PROJECT is missing", () => {
    vi.spyOn(subprocess, "commandExists").mockReturnValue(true);
    vi.stubEnv("SENTRY_AUTH_TOKEN", "sntryu_token");
    expect(() =>
      assertProviderAuth({
        firebase: false,
        sentry: true,
        sentryOrg: "test-org",
      }),
    ).toThrow(/SENTRY_PROJECT/);
  });

  it("reports every unauthenticated provider in one message", () => {
    vi.spyOn(subprocess, "commandExists").mockReturnValue(false);
    let message = "";
    try {
      assertProviderAuth({ firebase: true, sentry: true });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/gcp/);
    expect(message).toMatch(/sentry/);
  });
});

// ─── run — provider scoping & fail-fast rotation ──────────────────────────────

describe("run — provider scoping & fail-fast rotation", () => {
  let origEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    origEnv = { ...process.env };
    process.env.VERCEL_TOKEN = "test-token";
    process.env.VERCEL_PROJECT_ID = "prj_test";
    delete process.env.VERCEL_TEAM_ID;
    // Sentry is unauthenticated for this whole suite.
    delete process.env.SENTRY_AUTH_TOKEN;
    process.env.__SENTRY_CLIRC_PATH = path.join(os.tmpdir(), "no-such-clirc");
  });

  afterEach(() => {
    process.env = origEnv;
    vi.restoreAllMocks();
  });

  // vercel authenticated (whoami) and gcloud authenticated (auth list) — both
  // resolve through the single subprocess.run mock returning an account string.
  async function mockAuthedTools() {
    vi.spyOn(subprocess, "commandExists").mockReturnValue(true);
    vi.spyOn(subprocess, "run").mockReturnValue("rmartz");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  }

  async function mockBothProvidersPresent() {
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
        {
          id: "e2",
          key: "NEXT_PUBLIC_SENTRY_DSN",
          value: "https://abc@o0.ingest.sentry.io/1",
          target: ["production"],
          type: "plain",
        },
      ],
      pagination: undefined,
    });
  }

  it("fails fast without minting when a present provider is unauthenticated", async () => {
    await mockAuthedTools();
    await mockBothProvidersPresent();
    const firebase = await import("../lib/firebase");
    const rotateSpy = vi
      .spyOn(firebase, "rotateFirebase")
      .mockResolvedValue({ oldKeys: [], fp: null });

    await expect(
      run({ targetEnv: "production", invalidateKeys: true }),
    ).rejects.toThrow(/authenticated/i);
    // The Sentry preflight must trip before Firebase is ever minted — otherwise
    // we would leave the partial state issue #91 describes.
    expect(rotateSpy).not.toHaveBeenCalled();
  });

  it("scopes to firebase and skips a present but unauthenticated sentry", async () => {
    await mockAuthedTools();
    await mockBothProvidersPresent();
    const firebase = await import("../lib/firebase");
    const sentry = await import("../lib/sentry");
    const deployments = await import("../lib/deployments");
    const fbSpy = vi
      .spyOn(firebase, "rotateFirebase")
      .mockResolvedValue({ oldKeys: [], fp: null });
    const snSpy = vi.spyOn(sentry, "rotateSentry").mockResolvedValue("");
    vi.spyOn(deployments, "triggerAndWaitRedeployments").mockResolvedValue(
      undefined,
    );

    await run({
      targetEnv: "production",
      invalidateKeys: false,
      provider: "firebase",
    });

    expect(fbSpy).toHaveBeenCalledOnce();
    expect(snSpy).not.toHaveBeenCalled();
  });

  it("rejects `rotate firebase` when no Firebase keys are present", async () => {
    await mockAuthedTools();
    const { VercelClient } = await import("../lib/vercel-api");
    vi.spyOn(VercelClient.prototype, "listEnvVars").mockResolvedValue({
      envs: [
        {
          id: "e2",
          key: "NEXT_PUBLIC_SENTRY_DSN",
          value: "https://abc@o0.ingest.sentry.io/1",
          target: ["production"],
          type: "plain",
        },
      ],
      pagination: undefined,
    });

    await expect(
      run({
        targetEnv: "production",
        invalidateKeys: true,
        provider: "firebase",
      }),
    ).rejects.toThrow("nothing to rotate for `firebase`");
  });
});
