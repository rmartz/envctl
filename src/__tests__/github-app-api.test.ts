import { createPublicKey, verify } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readGithubAppPrivateKey } from "../lib/github-app";
import {
  checkGithubAppHookConfig,
  checkGithubAppKey,
  githubAppJwt,
  patchGithubAppHookConfig,
} from "../lib/github-app-api";
import { FatalError } from "../lib/logger";
import { makeGithubAppKeyFile } from "./fixtures";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "github-app-api-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("githubAppJwt", () => {
  it("signs an RS256 JWT verifiable with the App's public key", () => {
    const { key } = readGithubAppPrivateKey(makeGithubAppKeyFile(tmpDir));
    const [header, payload, signature] = githubAppJwt("Iv1.abc", key).split(
      ".",
    );
    const valid = verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      createPublicKey(key),
      Buffer.from(signature, "base64url"),
    );
    expect(valid).toBe(true);
  });

  it("issues as the Client ID with a backdated iat and a 9-minute expiry", () => {
    const { key } = readGithubAppPrivateKey(makeGithubAppKeyFile(tmpDir));
    const payload = githubAppJwt("Iv1.abc", key, 1_000_000).split(".")[1];
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({
      iat: 999_940,
      exp: 1_000_540,
      iss: "Iv1.abc",
    });
  });
});

describe("checkGithubAppHookConfig", () => {
  it("GETs the hook config as the App", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    await checkGithubAppHookConfig("jwt-1");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.github.com/app/hook/config",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("patchGithubAppHookConfig", () => {
  it("PATCHes the hook config with the URL and secret as the App", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    await patchGithubAppHookConfig("jwt-1", "https://x.test/hook", "s3cret");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.github.com/app/hook/config",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          url: "https://x.test/hook",
          secret: "s3cret",
          content_type: "json",
        }),
      }),
    );
  });

  it("maps a 404 to the inactive-webhook remedy", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Not Found", { status: 404 }),
    );
    await expect(
      patchGithubAppHookConfig("jwt-1", "https://x.test/hook", "s3cret"),
    ).rejects.toThrow(/webhook is not active/);
  });

  it("maps a 401 to a Client ID / key mismatch hint", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Bad credentials", { status: 401 }),
    );
    await expect(
      patchGithubAppHookConfig("jwt-1", "https://x.test/hook", "s3cret"),
    ).rejects.toThrow(/rejected the App JWT/);
  });

  it("throws a FatalError with GitHub's response for other failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Server Error", { status: 500 }),
    );
    await expect(
      patchGithubAppHookConfig("jwt-1", "https://x.test/hook", "s3cret"),
    ).rejects.toThrow(
      new FatalError(
        "GitHub API PATCH /app/hook/config failed (500): Server Error",
      ),
    );
  });
});

describe("checkGithubAppKey", () => {
  it("GETs /app as the App", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    await checkGithubAppKey("jwt-1");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.github.com/app",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("maps a 401 to a Client ID / key mismatch hint", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Bad credentials", { status: 401 }),
    );
    await expect(checkGithubAppKey("jwt-1")).rejects.toThrow(
      /rejected the App JWT/,
    );
  });
});
