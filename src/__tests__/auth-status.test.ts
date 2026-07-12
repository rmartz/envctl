import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveSentryToken } from "../lib/auth";
import * as subprocess from "../lib/subprocess";
import { runAuthStatus } from "../lib/commands/auth";

let tmpDir: string;
let clircPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "envctl-auth-"));
  clircPath = path.join(tmpDir, "sentryclirc");
  // Neutralize ambient credentials so tests are deterministic.
  vi.stubEnv("VERCEL_TOKEN", "");
  vi.stubEnv("SENTRY_AUTH_TOKEN", "");
  vi.stubEnv(
    "__VERCEL_CLI_AUTH_PATH",
    path.join(tmpDir, "no-vercel-auth.json"),
  );
  vi.stubEnv("__SENTRY_CLIRC_PATH", clircPath);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("resolveSentryToken", () => {
  it("prefers the SENTRY_AUTH_TOKEN env var", () => {
    vi.stubEnv("SENTRY_AUTH_TOKEN", "from-env");
    fs.writeFileSync(clircPath, "[auth]\ntoken=from-clirc\n");
    expect(resolveSentryToken()).toBe("from-env");
  });

  it("falls back to the sentry-cli ~/.sentryclirc token", () => {
    fs.writeFileSync(clircPath, "[auth]\ntoken=from-clirc\n");
    expect(resolveSentryToken()).toBe("from-clirc");
  });

  it("returns undefined when neither source has a token", () => {
    expect(resolveSentryToken()).toBeUndefined();
  });
});

describe("runAuthStatus", () => {
  it("reports every provider as unauthenticated with a hint when nothing is set", () => {
    vi.spyOn(subprocess, "commandExists").mockReturnValue(false); // no gcloud
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    runAuthStatus();
    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toMatch(/vercel\s+not authenticated/);
    expect(out).toMatch(/gcp\s+not authenticated/);
    expect(out).toMatch(/sentry\s+not authenticated/);
  });

  it("reports the source when a credential resolves (Vercel env, Sentry via clirc)", () => {
    vi.stubEnv("VERCEL_TOKEN", "vtok");
    fs.writeFileSync(clircPath, "token=stok\n");
    vi.spyOn(subprocess, "commandExists").mockReturnValue(false);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    runAuthStatus();
    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("vercel  authenticated (VERCEL_TOKEN env var)");
    expect(out).toContain("sentry  authenticated (sentry-cli login");
  });

  it("reports gcp authenticated with the active account from gcloud", () => {
    vi.spyOn(subprocess, "commandExists").mockReturnValue(true);
    vi.spyOn(subprocess, "run").mockReturnValue("me@example.com\n");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    runAuthStatus();
    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("gcp     authenticated (gcloud: me@example.com)");
  });
});
