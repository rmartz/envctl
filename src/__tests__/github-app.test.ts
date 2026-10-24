import { createPublicKey, verify } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkGithubAppHookConfig,
  githubAppConfigFor,
  githubAppJwt,
  patchGithubAppHookConfig,
  readGithubAppPrivateKey,
  resolveGithubAppVars,
} from "../lib/github-app";
import { FatalError } from "../lib/logger";
import { makeGithubAppKeyFile, makeManifestDir } from "./fixtures";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "github-app-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("resolveGithubAppVars", () => {
  it("defaults every field when no service is declared", () => {
    expect(resolveGithubAppVars()).toEqual({
      clientId: "GITHUB_APP_CLIENT_ID",
      privateKey: "GITHUB_APP_PRIVATE_KEY",
      webhookSecret: "GITHUB_APP_WEBHOOK_SECRET",
    });
  });

  it("applies a manifest override to its field", () => {
    const vars = resolveGithubAppVars({
      provider: "github-app",
      variables: { webhookSecret: "PR_LIFECYCLE_WEBHOOK_SECRET" },
    });
    expect(vars.webhookSecret).toBe("PR_LIFECYCLE_WEBHOOK_SECRET");
  });

  it("rejects an unknown field", () => {
    expect(() =>
      resolveGithubAppVars({
        provider: "github-app",
        variables: { appId: "X" },
      }),
    ).toThrow(/Unknown GitHub App variable field 'appId'/);
  });

  it("rejects two fields mapped to the same var", () => {
    expect(() =>
      resolveGithubAppVars({
        provider: "github-app",
        variables: { privateKey: "SAME", webhookSecret: "SAME" },
      }),
    ).toThrow(/'SAME' is mapped to multiple fields/);
  });
});

describe("githubAppConfigFor", () => {
  const manifest = [
    "environments: [staging, production]",
    "services:",
    "  - provider: github-app",
    "    environments: [production]",
    "    webhookUrl: https://app.example.com/api/webhook",
    "    variables:",
    "      clientId: APP_CLIENT_ID",
  ];

  it("reads the Client ID from an in-scope environment's config", () => {
    const dir = makeManifestDir(tmpDir, manifest, {
      staging: { APP_CLIENT_ID: "Iv1.staging" },
      production: { APP_CLIENT_ID: "Iv1.prod" },
    });
    expect(githubAppConfigFor(dir).clientId).toBe("Iv1.prod");
  });

  it("reads the webhook URL from the service declaration", () => {
    const dir = makeManifestDir(tmpDir, manifest);
    expect(githubAppConfigFor(dir).webhookUrl).toBe(
      "https://app.example.com/api/webhook",
    );
  });

  it("is undeclared without a github-app service", () => {
    const dir = makeManifestDir(tmpDir, ["environments: [production]"]);
    expect(githubAppConfigFor(dir).declared).toBe(false);
  });
});

describe("readGithubAppPrivateKey", () => {
  it("loads a valid RSA PEM", () => {
    const file = makeGithubAppKeyFile(tmpDir);
    expect(readGithubAppPrivateKey(file).key.asymmetricKeyType).toBe("rsa");
  });

  it("errors on a missing file", () => {
    expect(() =>
      readGithubAppPrivateKey(path.join(tmpDir, "absent.pem")),
    ).toThrow(/not found or unreadable/);
  });

  it("errors on a file that is not a PEM, without echoing its content", () => {
    const file = path.join(tmpDir, "bad.pem");
    fs.writeFileSync(file, "not-a-key-CANARY");
    expect(() => readGithubAppPrivateKey(file)).toThrow(
      new FatalError(`GitHub App private key file is not a valid PEM: ${file}`),
    );
  });

  it("errors on a PEM that is not an RSA key", () => {
    const file = makeGithubAppKeyFile(tmpDir, "ec");
    expect(() => readGithubAppPrivateKey(file)).toThrow(/not an RSA/);
  });
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
