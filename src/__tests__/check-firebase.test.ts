import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkFirebaseProjectDrift,
  checkFirebaseSaDrift,
} from "../lib/check-firebase";
import type { DeploymentProvider } from "../lib/providers/deployment";
import type { VercelEnvVar } from "../lib/vercel-api";

let tmpDir: string;
let configDir: string;

// Minimal deployment stub — getFirebaseSaForEnv only calls getEnvVarValue.
const fakeDeployment = (envs: VercelEnvVar[]): DeploymentProvider =>
  ({
    getEnvVarValue: (id: string) => {
      const e = envs.find((x) => x.id === id);
      return e ? Promise.resolve(e.value) : Promise.reject(new Error(id));
    },
  }) as unknown as DeploymentProvider;

// A live split credential on the production target with the given clientEmail
// and (for project-drift tests) projectId.
const liveSplit = (
  clientEmail: string,
  projectId = "gcp-proj",
): VercelEnvVar[] =>
  (
    [
      ["FIREBASE_PROJECT_ID", projectId],
      ["FIREBASE_CLIENT_EMAIL", clientEmail],
      ["FIREBASE_PRIVATE_KEY", "pk"],
      ["FIREBASE_PRIVATE_KEY_ID", "kid"],
    ] as const
  ).map(([key, value], i) => ({
    id: `p${i}`,
    key,
    value,
    target: ["production"],
    type: "encrypted" as const,
  }));

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "check-fb-"));
  configDir = path.join(tmpDir, "deployment");
  fs.mkdirSync(configDir);
  fs.writeFileSync(
    path.join(configDir, "manifest.yml"),
    [
      "environments: [production]",
      "deployments:",
      "  - provider: vercel",
      "    targets:",
      "      production: production",
      "services:",
      "  - provider: firebase",
      "",
    ].join("\n"),
  );
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const declareSaEmail = (email: string): void =>
  fs.writeFileSync(
    path.join(configDir, "production.yml"),
    `FIREBASE_SA_EMAIL: "${email}"\n`,
  );

const declareProjectId = (id: string): void =>
  fs.writeFileSync(
    path.join(configDir, "production.yml"),
    `FIREBASE_PROJECT_ID: "${id}"\n`,
  );

describe("checkFirebaseSaDrift (#103)", () => {
  it("errors when FIREBASE_SA_EMAIL disagrees with the credential's clientEmail", async () => {
    declareSaEmail("declared@x.iam");
    const live = liveSplit("different@y.iam");
    const found = await checkFirebaseSaDrift(
      fakeDeployment(live),
      configDir,
      live,
    );
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
    expect(found[0].message).toMatch(/declared@x\.iam.*different@y\.iam/);
  });

  it("warns that FIREBASE_SA_EMAIL is deprecated when it merely duplicates the credential", async () => {
    declareSaEmail("same@x.iam");
    const live = liveSplit("same@x.iam");
    const found = await checkFirebaseSaDrift(
      fakeDeployment(live),
      configDir,
      live,
    );
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
    expect(found[0].message).toMatch(/deprecated/i);
  });

  it("is silent when no FIREBASE_SA_EMAIL is declared", async () => {
    const live = liveSplit("same@x.iam");
    expect(
      await checkFirebaseSaDrift(fakeDeployment(live), configDir, live),
    ).toEqual([]);
  });

  it("is silent when no live credential exists to compare against", async () => {
    declareSaEmail("declared@x.iam");
    expect(
      await checkFirebaseSaDrift(fakeDeployment([]), configDir, []),
    ).toEqual([]);
  });
});

describe("checkFirebaseProjectDrift (#121)", () => {
  it("errors when FIREBASE_PROJECT_ID disagrees with the credential's projectId", async () => {
    declareProjectId("committed-proj");
    const live = liveSplit("sa@x.iam", "live-proj");
    const found = await checkFirebaseProjectDrift(
      fakeDeployment(live),
      configDir,
      live,
    );
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
    expect(found[0].message).toMatch(/committed-proj.*live-proj/);
  });

  it("is silent when FIREBASE_PROJECT_ID matches the credential's projectId (it is required, not deprecated)", async () => {
    declareProjectId("same-proj");
    const live = liveSplit("sa@x.iam", "same-proj");
    expect(
      await checkFirebaseProjectDrift(fakeDeployment(live), configDir, live),
    ).toEqual([]);
  });

  it("is silent when no FIREBASE_PROJECT_ID is declared", async () => {
    const live = liveSplit("sa@x.iam", "live-proj");
    expect(
      await checkFirebaseProjectDrift(fakeDeployment(live), configDir, live),
    ).toEqual([]);
  });

  it("is silent when no live credential exists to compare against", async () => {
    declareProjectId("committed-proj");
    expect(
      await checkFirebaseProjectDrift(fakeDeployment([]), configDir, []),
    ).toEqual([]);
  });
});
