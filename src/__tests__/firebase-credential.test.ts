import { describe, expect, it } from "vitest";

import {
  firebasePresenceKeys,
  resolveFirebaseCredential,
} from "../lib/firebase-credential";

describe("resolveFirebaseCredential", () => {
  it("defaults to the default split var names when no service is declared", () => {
    expect(resolveFirebaseCredential()).toEqual({
      names: {
        projectId: "FIREBASE_PROJECT_ID",
        clientEmail: "FIREBASE_CLIENT_EMAIL",
        privateKey: "FIREBASE_PRIVATE_KEY",
        privateKeyId: "FIREBASE_PRIVATE_KEY_ID",
      },
    });
  });

  it("overrides only the named fields, defaulting the rest", () => {
    const spec = resolveFirebaseCredential({
      provider: "firebase",
      variables: { privateKey: "FB_PK", projectId: "FB_PID" },
    });
    expect(spec.names.privateKey).toBe("FB_PK");
    expect(spec.names.projectId).toBe("FB_PID");
    expect(spec.names.clientEmail).toBe("FIREBASE_CLIENT_EMAIL");
  });

  it("throws on an empty override value", () => {
    expect(() =>
      resolveFirebaseCredential({
        provider: "firebase",
        variables: { privateKey: "" },
      }),
    ).toThrow(/privateKey/);
  });

  it("throws when two fields are mapped to the same var name", () => {
    expect(() =>
      resolveFirebaseCredential({
        provider: "firebase",
        variables: { privateKey: "FB_PK", privateKeyId: "FB_PK" },
      }),
    ).toThrow(/unique/);
  });
});

describe("firebasePresenceKeys", () => {
  it("returns the resolved privateKey name for the default spec", () => {
    const spec = resolveFirebaseCredential();
    expect(firebasePresenceKeys(spec)).toEqual(["FIREBASE_PRIVATE_KEY"]);
  });

  it("returns the custom resolved name for a custom-named spec", () => {
    const spec = resolveFirebaseCredential({
      provider: "firebase",
      variables: { privateKey: "FB_PK" },
    });
    expect(firebasePresenceKeys(spec)).toEqual(["FB_PK"]);
    // The legacy default name must not appear — it is inconsistent with what
    // the readers can find via the resolved names.
    expect(firebasePresenceKeys(spec)).not.toContain("FIREBASE_PRIVATE_KEY");
  });
});
