import { describe, expect, it } from "vitest";

import {
  firebasePresenceKeys,
  isDeprecatedCredential,
  patternVarNames,
  resolveFirebaseCredential,
} from "../lib/firebase-credential";

describe("resolveFirebaseCredential", () => {
  it("defaults to split + default names when no service is declared", () => {
    expect(resolveFirebaseCredential()).toEqual({
      pattern: "split",
      names: {
        serviceAccount: "FIREBASE_SERVICE_ACCOUNT",
        projectId: "FIREBASE_PROJECT_ID",
        clientEmail: "FIREBASE_CLIENT_EMAIL",
        privateKey: "FIREBASE_PRIVATE_KEY",
        privateKeyId: "FIREBASE_PRIVATE_KEY_ID",
      },
    });
  });

  it("still honors the deprecated json shape when explicitly declared", () => {
    expect(
      resolveFirebaseCredential({ provider: "firebase", credential: "json" })
        .pattern,
    ).toBe("json");
  });

  it("overrides only the named fields, defaulting the rest", () => {
    const spec = resolveFirebaseCredential({
      provider: "firebase",
      credential: "split",
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

describe("isDeprecatedCredential", () => {
  it("flags an explicit json declaration", () => {
    expect(
      isDeprecatedCredential({ provider: "firebase", credential: "json" }),
    ).toBe(true);
  });

  it("does not flag the default or a split declaration", () => {
    expect(isDeprecatedCredential()).toBe(false);
    expect(
      isDeprecatedCredential({ provider: "firebase", credential: "split" }),
    ).toBe(false);
  });
});

describe("patternVarNames", () => {
  it("lists the single var for the json shape", () => {
    const { names } = resolveFirebaseCredential();
    expect(patternVarNames(names, "json")).toEqual([
      "FIREBASE_SERVICE_ACCOUNT",
    ]);
  });

  it("lists the discrete vars for the split shape", () => {
    const { names } = resolveFirebaseCredential();
    expect(patternVarNames(names, "split")).toEqual([
      "FIREBASE_PROJECT_ID",
      "FIREBASE_CLIENT_EMAIL",
      "FIREBASE_PRIVATE_KEY",
      "FIREBASE_PRIVATE_KEY_ID",
    ]);
  });
});

describe("firebasePresenceKeys", () => {
  it("returns the resolved serviceAccount and privateKey names for default spec", () => {
    const spec = resolveFirebaseCredential();
    expect(firebasePresenceKeys(spec)).toEqual([
      "FIREBASE_SERVICE_ACCOUNT",
      "FIREBASE_PRIVATE_KEY",
    ]);
  });

  it("returns only the custom resolved names for a custom-named spec", () => {
    const spec = resolveFirebaseCredential({
      provider: "firebase",
      credential: "split",
      variables: { privateKey: "FB_PK" },
    });
    expect(firebasePresenceKeys(spec)).toContain("FB_PK");
    expect(firebasePresenceKeys(spec)).toContain("FIREBASE_SERVICE_ACCOUNT");
    // Legacy default name must not appear — it is inconsistent with what
    // detectExistingPattern can find via the resolved names.
    expect(firebasePresenceKeys(spec)).not.toContain("FIREBASE_PRIVATE_KEY");
  });
});
