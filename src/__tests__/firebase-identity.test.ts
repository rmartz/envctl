import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as gcp from "../lib/gcp";
import { initFirebase, rotateFirebase } from "../lib/firebase";
import { FatalError } from "../lib/logger";
import { resolveFirebaseCredential } from "../lib/firebase-credential";
import type { VercelEnvVar } from "../lib/vercel-api";

import { MINTED, FakeVercel, asClient, valueFor, envVar } from "./fixtures";

// #103 / #126 — how `init` and `rotate` resolve the Firebase service account.
describe("SA identity resolution (#103 / #126)", () => {
  let tmp: string;

  // A split credential already present on the preview target — a *different*
  // environment's credential that init must never contaminate another target
  // with (#126).
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

  it("init uses the target's own declared SA and never another target's credential (#126)", async () => {
    // preview already holds a *staging*-project credential; initializing the
    // blank production target must mint production's own SA, not derive staging.
    const fake = new FakeVercel(
      previewSplit(
        "firebase-adminsdk@trip-staging.iam.gserviceaccount.com",
        "trip-staging",
      ),
    );
    const createSpy = vi.spyOn(gcp, "createGcpKey");
    await initFirebase(
      "production",
      asClient(fake),
      tmp,
      "firebase-adminsdk@trip-prod.iam.gserviceaccount.com",
      "trip-prod",
      resolveFirebaseCredential(),
    );
    // Minted for PRODUCTION's SA — never the staging credential on preview.
    expect(createSpy).toHaveBeenCalledWith(
      expect.any(String),
      "firebase-adminsdk@trip-prod.iam.gserviceaccount.com",
      "trip-prod",
    );
    expect(createSpy).not.toHaveBeenCalledWith(
      expect.any(String),
      "firebase-adminsdk@trip-staging.iam.gserviceaccount.com",
      expect.anything(),
    );
    // production gets production's identity; preview's credential is untouched.
    expect(valueFor(fake, "FIREBASE_CLIENT_EMAIL", "production")).toBe(
      "firebase-adminsdk@trip-prod.iam.gserviceaccount.com",
    );
    expect(valueFor(fake, "FIREBASE_CLIENT_EMAIL", "preview")).toBe(
      "firebase-adminsdk@trip-staging.iam.gserviceaccount.com",
    );
  });

  it("init cold-inits from the declared FIREBASE_SA_EMAIL, with a deprecation warning", async () => {
    const fake = new FakeVercel();
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

  it("init refuses when the SA's project disagrees with the target's declared project (#126)", async () => {
    const fake = new FakeVercel();
    const createSpy = vi.spyOn(gcp, "createGcpKey");
    await expect(
      initFirebase(
        "production",
        asClient(fake),
        tmp,
        "firebase-adminsdk@trip-staging.iam.gserviceaccount.com",
        "trip-prod",
        resolveFirebaseCredential(),
      ),
    ).rejects.toBeInstanceOf(FatalError);
    // Nothing minted — refused before any key was created.
    expect(createSpy).not.toHaveBeenCalled();
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
