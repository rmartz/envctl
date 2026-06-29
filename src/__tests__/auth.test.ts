import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveVercelToken } from "../lib/auth";

describe("resolveVercelToken", () => {
  let origEnv: NodeJS.ProcessEnv;
  let tmpDir: string;
  let authFile: string;

  beforeEach(() => {
    origEnv = { ...process.env };
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-test-"));
    authFile = path.join(tmpDir, "auth.json");
    process.env.__VERCEL_CLI_AUTH_PATH = authFile;
    delete process.env.VERCEL_TOKEN;
  });

  afterEach(() => {
    process.env = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns VERCEL_TOKEN when set", () => {
    process.env.VERCEL_TOKEN = "tok_from_env";
    expect(resolveVercelToken()).toBe("tok_from_env");
  });

  it("reads token from CLI auth file when VERCEL_TOKEN is unset", () => {
    fs.writeFileSync(
      authFile,
      JSON.stringify({
        token: "tok_from_cli",
        expiresAt: Date.now() / 1000 + 3600,
      }),
    );
    expect(resolveVercelToken()).toBe("tok_from_cli");
  });

  it("prefers VERCEL_TOKEN over CLI auth file", () => {
    process.env.VERCEL_TOKEN = "tok_from_env";
    fs.writeFileSync(authFile, JSON.stringify({ token: "tok_from_cli" }));
    expect(resolveVercelToken()).toBe("tok_from_env");
  });

  it("returns undefined when CLI token is expired", () => {
    fs.writeFileSync(
      authFile,
      JSON.stringify({
        token: "expired_tok",
        expiresAt: Date.now() / 1000 - 1,
      }),
    );
    expect(resolveVercelToken()).toBeUndefined();
  });

  it("returns undefined when CLI auth file is absent", () => {
    // authFile was not written — does not exist
    expect(resolveVercelToken()).toBeUndefined();
  });

  it("returns undefined when CLI auth file has no token field", () => {
    fs.writeFileSync(authFile, JSON.stringify({ userId: "u123" }));
    expect(resolveVercelToken()).toBeUndefined();
  });

  it("returns token when expiresAt is absent (non-expiring token)", () => {
    fs.writeFileSync(authFile, JSON.stringify({ token: "permanent_tok" }));
    expect(resolveVercelToken()).toBe("permanent_tok");
  });
});
