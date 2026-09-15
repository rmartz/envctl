import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as gcp from "../lib/gcp";
import { initFirebase, rotateFirebase } from "../lib/firebase";
import { resolveFirebaseCredential } from "../lib/firebase-credential";
import type { VercelClient, VercelEnvVar } from "../lib/vercel-api";

const MINTED = {
  private_key_id: "new-key-id",
  private_key: "-----BEGIN PRIVATE KEY-----\nnew\n-----END PRIVATE KEY-----\n",
  client_email: "sa@proj.iam.gserviceaccount.com",
  project_id: "proj-x",
};

// In-memory stand-in for VercelClient — tracks a live env-var store so writes,
// deletes, and reads compose the way the real API does, without any network.
class FakeVercel {
  private seq = 0;
  envs: VercelEnvVar[];
  constructor(envs: VercelEnvVar[] = []) {
    this.envs = envs;
  }
  listEnvVars(): Promise<{ envs: VercelEnvVar[]; pagination: undefined }> {
    return Promise.resolve({
      envs: this.envs.map((e) => ({ ...e })),
      pagination: undefined,
    });
  }
  getEnvVarValue(id: string): Promise<string> {
    const e = this.envs.find((x) => x.id === id);
    return e
      ? Promise.resolve(e.value)
      : Promise.reject(new Error(`no var ${id}`));
  }
  findEnvVar(
    envs: VercelEnvVar[],
    key: string,
    target: string,
  ): VercelEnvVar | undefined {
    return envs.find((e) => e.key === key && e.target.includes(target));
  }
  deleteEnvVar(id: string): Promise<void> {
    this.envs = this.envs.filter((e) => e.id !== id);
    return Promise.resolve();
  }
  removeEnvVarFromTarget(
    id: string,
    existingTargets: string[],
    vercelEnv: string,
  ): Promise<void> {
    const remaining = existingTargets.filter((t) => t !== vercelEnv);
    if (remaining.length === 0) {
      this.envs = this.envs.filter((e) => e.id !== id);
    } else {
      this.envs = this.envs.map((e) =>
        e.id === id ? { ...e, target: remaining } : e,
      );
    }
    return Promise.resolve();
  }
  setEnvForTarget(
    key: string,
    value: string,
    target: string,
    _all: VercelEnvVar[],
    type: "plain" | "encrypted" = "encrypted",
  ): Promise<string> {
    this.envs = this.envs.filter(
      (e) => !(e.key === key && e.target.includes(target)),
    );
    const id = `id-${++this.seq}`;
    this.envs.push({ id, key, value, target: [target], type });
    return Promise.resolve(id);
  }
}

const asClient = (fake: FakeVercel): VercelClient =>
  fake as unknown as VercelClient;

const keysFor = (fake: FakeVercel, target: string): string[] =>
  fake.envs
    .filter((e) => e.target.includes(target))
    .map((e) => e.key)
    .sort();

const valueFor = (
  fake: FakeVercel,
  key: string,
  target: string,
): string | undefined =>
  fake.envs.find((e) => e.key === key && e.target.includes(target))?.value;

const envVar = (id: string, key: string, value: string): VercelEnvVar => ({
  id,
  key,
  value,
  target: ["production"],
  type: "encrypted",
});

describe("firebase credential provisioning", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fb-test-"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
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

    it("writes only FIREBASE_SERVICE_ACCOUNT under the deprecated json shape", async () => {
      const fake = new FakeVercel();
      const spec = resolveFirebaseCredential({
        provider: "firebase",
        credential: "json",
      });
      await initFirebase(
        "production",
        asClient(fake),
        tmp,
        "sa@proj.iam",
        "proj-x",
        spec,
      );
      expect(keysFor(fake, "production")).toEqual(["FIREBASE_SERVICE_ACCOUNT"]);
      expect(
        valueFor(fake, "FIREBASE_SERVICE_ACCOUNT", "production"),
      ).toContain("new-key-id");
    });

    it("uses the declared custom var names (#98)", async () => {
      const fake = new FakeVercel();
      const spec = resolveFirebaseCredential({
        provider: "firebase",
        credential: "split",
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
        credential: "split",
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

    it("migrates json→split and removes the stale FIREBASE_SERVICE_ACCOUNT (#97)", async () => {
      const fake = new FakeVercel([
        envVar(
          "e1",
          "FIREBASE_SERVICE_ACCOUNT",
          JSON.stringify({
            client_email: "sa@proj.iam",
            project_id: "proj-x",
            private_key_id: "old-json-key",
          }),
        ),
      ]);
      const spec = resolveFirebaseCredential({
        provider: "firebase",
        credential: "split",
      });
      const { oldKeys } = await rotateFirebase(
        "production",
        asClient(fake),
        tmp,
        spec,
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
      expect(oldKeys.map((k) => k.keyId)).toEqual(["old-json-key"]);
    });

    it("migrates split→json and removes the stale split vars", async () => {
      const fake = new FakeVercel(splitEnvs());
      const spec = resolveFirebaseCredential({
        provider: "firebase",
        credential: "json",
      });
      await rotateFirebase("production", asClient(fake), tmp, spec);
      expect(keysFor(fake, "production")).toEqual(["FIREBASE_SERVICE_ACCOUNT"]);
    });

    it("is retry-safe for an interrupted split→json migration (item 4)", async () => {
      // Simulates an interrupted split→json: json var was already written but
      // split vars were not yet removed. A retry should detect json (existing
      // pattern = declared), NOT set migratingEnv, yet still remove the stale
      // split vars unconditionally.
      const fake = new FakeVercel([
        envVar("e1", "FIREBASE_PROJECT_ID", "proj-x"),
        envVar("e2", "FIREBASE_CLIENT_EMAIL", "sa@proj.iam"),
        envVar("e3", "FIREBASE_PRIVATE_KEY", "old-pk"),
        envVar("e4", "FIREBASE_PRIVATE_KEY_ID", "old-key-id"),
        envVar(
          "e5",
          "FIREBASE_SERVICE_ACCOUNT",
          JSON.stringify({
            client_email: "sa@proj.iam",
            project_id: "proj-x",
            private_key_id: "partial-key",
          }),
        ),
      ]);
      const spec = resolveFirebaseCredential({
        provider: "firebase",
        credential: "json",
      });
      await rotateFirebase("production", asClient(fake), tmp, spec);
      expect(keysFor(fake, "production")).toEqual(["FIREBASE_SERVICE_ACCOUNT"]);
    });

    it("does not delete a shared-target record's other targets on removal (item 5)", async () => {
      // A shared record covers both production and preview. Rotating production
      // should only remove production from the record, not delete it entirely.
      const shared: VercelEnvVar = {
        id: "shared-1",
        key: "FIREBASE_SERVICE_ACCOUNT",
        value: JSON.stringify({
          client_email: "sa@proj.iam",
          project_id: "proj-x",
          private_key_id: "old-json-key",
        }),
        target: ["production", "preview"],
        type: "encrypted",
      };
      const fake = new FakeVercel([shared]);
      const spec = resolveFirebaseCredential({
        provider: "firebase",
        credential: "split",
      });
      await rotateFirebase("production", asClient(fake), tmp, spec);
      // The json service-account record should now only cover preview (not deleted)
      const remaining = fake.envs.find(
        (e) => e.key === "FIREBASE_SERVICE_ACCOUNT",
      );
      expect(remaining?.target).toEqual(["preview"]);
      // And the new split vars should only cover production
      expect(keysFor(fake, "production")).toEqual([
        "FIREBASE_CLIENT_EMAIL",
        "FIREBASE_PRIVATE_KEY",
        "FIREBASE_PRIVATE_KEY_ID",
        "FIREBASE_PROJECT_ID",
      ]);
    });

    it("round-trips custom-named split vars through init then rotate (#98)", async () => {
      const fake = new FakeVercel();
      const spec = resolveFirebaseCredential({
        provider: "firebase",
        credential: "split",
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
        credential: "split",
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
