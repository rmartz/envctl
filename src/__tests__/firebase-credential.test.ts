import { describe, expect, it } from "vitest";

import {
  firebasePresenceKeys,
  patternVarNames,
  resolveFirebaseCredential,
} from "../lib/firebase-credential";

describe("resolveFirebaseCredential", () => {
  it("defaults to json + default names when no service is declared", () => {
    expect(resolveFirebaseCredential()).toEqual({
      pattern: "json",
      names: {
        serviceAccount: "FIREBASE_SERVICE_ACCOUNT",
        projectId: "FIREBASE_PROJECT_ID",
        clientEmail: "FIREBASE_CLIENT_EMAIL",
        privateKey: "FIREBASE_PRIVATE_KEY",
        privateKeyId: "FIREBASE_PRIVATE_KEY_ID",
      },
    });
  });

  it("honors a declared split shape", () => {
    expect(
      resolveFirebaseCredential({ provider: "firebase", credential: "split" })
        .pattern,
    ).toBe("split");
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
  it("covers a custom private-key name alongside the defaults", () => {
    const spec = resolveFirebaseCredential({
      provider: "firebase",
      credential: "split",
      variables: { privateKey: "FB_PK" },
    });
    expect(firebasePresenceKeys(spec)).toContain("FB_PK");
    expect(firebasePresenceKeys(spec)).toContain("FIREBASE_SERVICE_ACCOUNT");
  });
});
