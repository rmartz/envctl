import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkCollisions } from "../lib/check-collisions";
import { checkServiceContext } from "../lib/check-completeness";
import { parseManifest } from "../lib/manifest";
import type { DeploymentProvider } from "../lib/providers/deployment";
import { envTargetResolver } from "../lib/targets";
import type { VercelEnvVar } from "../lib/vercel-api";
import { makeLiveVar, makeManifestDir } from "./fixtures";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "check-collide-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const MANIFEST = [
  "environments: [production, staging, preview]",
  "deployments:",
  "  - provider: vercel",
  "    targets:",
  "      production: production",
  "      staging: preview",
  "      preview: preview",
  "services:",
  "  - provider: firebase",
];

// Decrypts by returning the stored value — encrypted live vars are readable.
const makeDeployment = (live: VercelEnvVar[]): DeploymentProvider =>
  ({
    getEnvVarValue: (id: string) => {
      const e = live.find((x) => x.id === id);
      return e ? Promise.resolve(e.value) : Promise.reject(new Error(id));
    },
  }) as unknown as DeploymentProvider;

async function collisions(
  live: VercelEnvVar[],
  overlays: Record<string, Record<string, string>> = {},
) {
  const dir = makeManifestDir(tmpDir, MANIFEST, overlays);
  const manifest = parseManifest(dir);
  const ctx = checkServiceContext(manifest, makeDeployment(live));
  return checkCollisions(manifest, ctx, live, envTargetResolver(dir));
}

describe("checkCollisions — isolated vars across environments", () => {
  it("errors when two targets share the Firebase project id", async () => {
    const found = await collisions([
      makeLiveVar("FIREBASE_PROJECT_ID", "production", "shared-proj"),
      makeLiveVar("FIREBASE_PROJECT_ID", "preview", "shared-proj"),
    ]);
    expect(found).toEqual([
      expect.objectContaining({
        severity: "error",
        kind: "collision",
        key: "FIREBASE_PROJECT_ID",
      }),
    ]);
  });

  it("passes when each target has its own project id", async () => {
    const found = await collisions([
      makeLiveVar("FIREBASE_PROJECT_ID", "production", "prod-proj"),
      makeLiveVar("FIREBASE_PROJECT_ID", "preview", "staging-proj"),
    ]);
    expect(found).toEqual([]);
  });

  it("falls back to the declared literal when the var is not live", async () => {
    const found = await collisions(
      [makeLiveVar("FIREBASE_PROJECT_ID", "production", "same-proj")],
      { staging: { FIREBASE_PROJECT_ID: "same-proj" } },
    );
    expect(found.map((f) => f.kind)).toEqual(["collision"]);
  });

  it("notes a sensitive var with no declared value as skipped", async () => {
    const found = await collisions([
      makeLiveVar("FIREBASE_PROJECT_ID", "production", "", "sensitive"),
    ]);
    expect(found).toEqual([
      expect.objectContaining({
        severity: "warning",
        kind: "collision-skipped",
        target: "production",
      }),
    ]);
  });
});
