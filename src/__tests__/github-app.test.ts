import { createHash, createPublicKey } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  githubAppConfigFor,
  githubAppKeyFingerprint,
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

describe("githubAppKeyFingerprint", () => {
  it("is SHA256: + base64 of the SHA-256 of the public key's DER", () => {
    const { key } = readGithubAppPrivateKey(makeGithubAppKeyFile(tmpDir));
    const der = createPublicKey(key).export({ type: "spki", format: "der" });
    expect(githubAppKeyFingerprint(key)).toBe(
      `SHA256:${createHash("sha256").update(der).digest("base64")}`,
    );
  });
});
