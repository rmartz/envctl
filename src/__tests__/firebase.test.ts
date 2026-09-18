import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as gcp from "../lib/gcp";
import { initFirebase, rotateFirebase } from "../lib/firebase";
import { resolveFirebaseCredential } from "../lib/firebase-credential";
import type { VercelEnvVar } from "../lib/vercel-api";

import { MINTED, FakeVercel, asClient, valueFor, envVar } from "./fixtures";

const keysFor = (fake: FakeVercel, target: string): string[] =>
  fake.envs
    .filter((e) => e.target.includes(target))
    .map((e) => e.key)
    .sort();

describe("firebase credential provisioning", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fb-test-"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(gcp, "createGcpKey").mockImplementation((keyFile: string) => {
      fs.writeFileSync(keyFile, JSON.stringify(MINTED));
    });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("initFirebase", () => {
    it("writes the four split vars by default (no shape declared)", async () => {
      const fake = new FakeVercel();
      await initFirebase(
        "production",
        asClient(fake),
        tmp,
        "sa@proj.iam",
        "proj-x",
        resolveFirebaseCredential(),
      );
      expect(keysFor(fake, "production")).toEqual([
        "FIREBASE_CLIENT_EMAIL",
        "FIREBASE_PRIVATE_KEY",
        "FIREBASE_PRIVATE_KEY_ID",
        "FIREBASE_PROJECT_ID",
      ]);
      expect(valueFor(fake, "FIREBASE_PROJECT_ID", "production")).toBe(
        "proj-x",
      );
      expect(valueFor(fake, "FIREBASE_CLIENT_EMAIL", "production")).toBe(
        "sa@proj.iam",
      );
      expect(valueFor(fake, "FIREBASE_PRIVATE_KEY", "production")).toContain(
        "BEGIN",
      );
    });

    it("uses the declared custom var names (#98)", async () => {
      const fake = new FakeVercel();
      const spec = resolveFirebaseCredential({
        provider: "firebase",
        variables: {
          projectId: "FB_PID",
          clientEmail: "FB_CE",
          privateKey: "FB_PK",
          privateKeyId: "FB_PKID",
        },
      });
      await initFirebase(
        "production",
        asClient(fake),
        tmp,
        "sa@proj.iam",
        "proj-x",
        spec,
      );
      expect(keysFor(fake, "production")).toEqual([
        "FB_CE",
        "FB_PID",
        "FB_PK",
        "FB_PKID",
      ]);
    });
  });

  describe("rotateFirebase", () => {
    const splitEnvs = (): VercelEnvVar[] => [
      envVar("e1", "FIREBASE_PROJECT_ID", "proj-x"),
      envVar("e2", "FIREBASE_CLIENT_EMAIL", "sa@proj.iam"),
      envVar("e3", "FIREBASE_PRIVATE_KEY", "old-pk"),
      envVar("e4", "FIREBASE_PRIVATE_KEY_ID", "old-key-id"),
    ];

    it("rotates the key in place under a declared split shape", async () => {
      const fake = new FakeVercel(splitEnvs());
      const spec = resolveFirebaseCredential({
        provider: "firebase",
      });
      const { oldKeys } = await rotateFirebase(
        "production",
        asClient(fake),
        tmp,
        spec,
      );
      expect(valueFor(fake, "FIREBASE_PRIVATE_KEY_ID", "production")).toBe(
        "new-key-id",
      );
      expect(valueFor(fake, "FIREBASE_PRIVATE_KEY", "production")).toContain(
        "new",
      );
      expect(oldKeys.map((k) => k.keyId)).toEqual(["old-key-id"]);
      expect(fake.envs.some((e) => e.key === "FIREBASE_SERVICE_ACCOUNT")).toBe(
        false,
      );
    });

    it("round-trips custom-named split vars through init then rotate (#98)", async () => {
      const fake = new FakeVercel();
      const spec = resolveFirebaseCredential({
        provider: "firebase",
        variables: {
          projectId: "FB_PID",
          clientEmail: "FB_CE",
          privateKey: "FB_PK",
          privateKeyId: "FB_PKID",
        },
      });
      await initFirebase(
        "production",
        asClient(fake),
        tmp,
        "sa@proj.iam",
        "proj-x",
        spec,
      );
      vi.mocked(gcp.createGcpKey).mockImplementation((keyFile: string) => {
        fs.writeFileSync(
          keyFile,
          JSON.stringify({ ...MINTED, private_key_id: "rotated-key-id" }),
        );
      });
      const { oldKeys } = await rotateFirebase(
        "production",
        asClient(fake),
        tmp,
        spec,
      );
      expect(keysFor(fake, "production")).toEqual([
        "FB_CE",
        "FB_PID",
        "FB_PK",
        "FB_PKID",
      ]);
      expect(valueFor(fake, "FB_PKID", "production")).toBe("rotated-key-id");
      expect(oldKeys.map((k) => k.keyId)).toEqual(["new-key-id"]);
    });

    it("rotates only the allowed targets when the service is scoped (#89)", async () => {
      // Split credential present on BOTH production and preview.
      const both = (target: string): VercelEnvVar[] => [
        {
          id: `${target}-pid`,
          key: "FIREBASE_PROJECT_ID",
          value: "proj-x",
          target: [target],
          type: "encrypted",
        },
        {
          id: `${target}-ce`,
          key: "FIREBASE_CLIENT_EMAIL",
          value: "sa@proj.iam",
          target: [target],
          type: "encrypted",
        },
        {
          id: `${target}-pk`,
          key: "FIREBASE_PRIVATE_KEY",
          value: "old-pk",
          target: [target],
          type: "encrypted",
        },
        {
          id: `${target}-pkid`,
          key: "FIREBASE_PRIVATE_KEY_ID",
          value: `old-${target}`,
          target: [target],
          type: "encrypted",
        },
      ];
      const fake = new FakeVercel([...both("production"), ...both("preview")]);
      const spec = resolveFirebaseCredential({
        provider: "firebase",
      });

      await rotateFirebase("all", asClient(fake), tmp, spec, ["production"]);

      // production rotated to the new key; preview left untouched.
      expect(valueFor(fake, "FIREBASE_PRIVATE_KEY_ID", "production")).toBe(
        "new-key-id",
      );
      expect(valueFor(fake, "FIREBASE_PRIVATE_KEY_ID", "preview")).toBe(
        "old-preview",
      );
    });
  });
});
