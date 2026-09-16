import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as gcp from "../lib/gcp";
import { initFirebase, rotateFirebase } from "../lib/firebase";
import { resolveFirebaseCredential } from "../lib/firebase-credential";
import type { VercelEnvVar } from "../lib/vercel-api";

import { MINTED, FakeVercel, asClient, valueFor, envVar } from "./fixtures";

// #103 — the SA identity is derived from the credential, not from a separately
// declared FIREBASE_SA_EMAIL.
describe("SA identity derivation (#103)", () => {
  let tmp: string;

  const previewSplit = (email: string, project: string): VercelEnvVar[] =>
    (
      [
        ["FIREBASE_PROJECT_ID", project],
        ["FIREBASE_CLIENT_EMAIL", email],
        ["FIREBASE_PRIVATE_KEY", "pk"],
        ["FIREBASE_PRIVATE_KEY_ID", "kid"],
      ] as const
    ).map(([key, value], i) => ({
      id: `pv${i}`,
      key,
      value,
      target: ["preview"],
      type: "encrypted" as const,
    }));

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fb-test-"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(gcp, "createGcpKey").mockImplementation((keyFile: string) => {
      fs.writeFileSync(keyFile, JSON.stringify(MINTED));
    });
    delete process.env.FIREBASE_SA_EMAIL;
    delete process.env.GCLOUD_PROJECT;
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("init derives the SA email from a sibling credential's clientEmail", async () => {
    const fake = new FakeVercel(
      previewSplit("derived@proj.iam", "gcp-derived"),
    );
    const createSpy = vi.spyOn(gcp, "createGcpKey");
    await initFirebase(
      "production",
      asClient(fake),
      tmp,
      undefined,
      undefined,
      resolveFirebaseCredential(),
    );
    // Minted for the SA derived from preview — no FIREBASE_SA_EMAIL involved.
    expect(createSpy).toHaveBeenCalledWith(
      expect.any(String),
      "derived@proj.iam",
      "gcp-derived",
    );
    expect(valueFor(fake, "FIREBASE_CLIENT_EMAIL", "production")).toBe(
      "derived@proj.iam",
    );
  });

  it("init derives the SA email from a json-shape sibling credential", async () => {
    const blob = JSON.stringify({
      client_email: "json@proj.iam",
      project_id: "gcp-json",
      private_key_id: "kid",
    });
    const fake = new FakeVercel([
      {
        id: "j1",
        key: "FIREBASE_SERVICE_ACCOUNT",
        value: blob,
        target: ["preview"],
        type: "encrypted",
      },
    ]);
    const createSpy = vi.spyOn(gcp, "createGcpKey");
    await initFirebase(
      "production",
      asClient(fake),
      tmp,
      undefined,
      undefined,
      resolveFirebaseCredential({ provider: "firebase", credential: "json" }),
    );
    expect(createSpy).toHaveBeenCalledWith(
      expect.any(String),
      "json@proj.iam",
      "gcp-json",
    );
  });

  it("init falls back to a declared FIREBASE_SA_EMAIL on a blank project, with a deprecation warning", async () => {
    const fake = new FakeVercel(); // nothing to derive from
    const createSpy = vi.spyOn(gcp, "createGcpKey");
    const warnSpy = vi.spyOn(console, "error");
    await initFirebase(
      "production",
      asClient(fake),
      tmp,
      "declared@proj.iam",
      "gcp-x",
      resolveFirebaseCredential(),
    );
    expect(createSpy).toHaveBeenCalledWith(
      expect.any(String),
      "declared@proj.iam",
      "gcp-x",
    );
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
      /FIREBASE_SA_EMAIL.*deprecated/i,
    );
  });

  it("rotate mints for the credential's SA, ignoring a stale FIREBASE_SA_EMAIL", async () => {
    process.env.FIREBASE_SA_EMAIL = "stale@wrong.iam";
    const fake = new FakeVercel([
      envVar("e1", "FIREBASE_PROJECT_ID", "proj-x"),
      envVar("e2", "FIREBASE_CLIENT_EMAIL", "real@proj.iam"),
      envVar("e3", "FIREBASE_PRIVATE_KEY", "old-pk"),
      envVar("e4", "FIREBASE_PRIVATE_KEY_ID", "old-key-id"),
    ]);
    const createSpy = vi.spyOn(gcp, "createGcpKey");
    await rotateFirebase(
      "production",
      asClient(fake),
      tmp,
      resolveFirebaseCredential({
        provider: "firebase",
        credential: "split",
      }),
    );
    expect(createSpy).toHaveBeenCalledWith(
      expect.any(String),
      "real@proj.iam",
      "proj-x",
    );
    expect(createSpy).not.toHaveBeenCalledWith(
      expect.any(String),
      "stale@wrong.iam",
      expect.anything(),
    );
  });
});
