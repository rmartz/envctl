import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkStatic } from "../../lib/check";
import { runEnvAdd } from "../../lib/commands/env";
import { FatalError } from "../../lib/logger";
import {
  manifestErrors,
  parseManifest,
  soleDeployment,
  type ResolvedManifest,
} from "../../lib/manifest";
import { resolveProjectDeployment } from "../../lib/providers/registry";

let workingDir: string;
let deployDir: string;

beforeEach(() => {
  workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "named-deployments-"));
  deployDir = path.join(workingDir, "deployment");
  fs.mkdirSync(deployDir);
  vi.stubEnv("VERCEL_PROJECT_ID", "prj_test");
  vi.stubEnv("VERCEL_TOKEN", "test-token");
});

afterEach(() => {
  fs.rmSync(workingDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function makeManifest(lines: string[]): void {
  fs.writeFileSync(
    path.join(deployDir, "manifest.yml"),
    lines.join("\n") + "\n",
  );
}

// Two named deployments sharing a sentry service, each with its own App.
const TWO_DEPLOYMENTS = [
  "environments: [production, staging]",
  "services:",
  "  - provider: sentry",
  "  - name: actor-app",
  "    provider: github-app",
  "  - name: gate-app",
  "    provider: github-app",
  "deployments:",
  "  - name: actor",
  "    provider: vercel",
  "    services: [actor-app, sentry]",
  "    environments: [production]",
  "    targets: { production: production }",
  "    variables:",
  "      PR_APP_ROLE: { value: actor }",
  "  - name: gate",
  "    provider: vercel",
  "    services: [gate-app, sentry]",
  "    targets: { production: production }",
];

function makeModel(over: Partial<ResolvedManifest>): ResolvedManifest {
  return {
    environments: ["production"],
    deployments: [],
    services: [],
    variables: [],
    variableGroups: [],
    overlays: {},
    ...over,
  };
}

describe("parsing named deployments and services", () => {
  it("parses a deployment's name, services, environments and variables", () => {
    makeManifest(TWO_DEPLOYMENTS);
    expect(parseManifest(deployDir).deployments[0]).toEqual({
      name: "actor",
      provider: "vercel",
      services: ["actor-app", "sentry"],
      environments: ["production"],
      targets: { production: "production" },
      variables: [
        { name: "PR_APP_ROLE", source: { kind: "value", value: "actor" } },
      ],
    });
  });

  it("names services explicitly or by provider", () => {
    makeManifest(TWO_DEPLOYMENTS);
    expect(parseManifest(deployDir).services.map((s) => s.name)).toEqual([
      "sentry",
      "actor-app",
      "gate-app",
    ]);
  });

  it("leaves services and environments unset when a deployment omits them", () => {
    makeManifest(TWO_DEPLOYMENTS);
    const gate = parseManifest(deployDir).deployments[1];
    expect([gate?.services, gate?.environments]).toEqual([
      ["gate-app", "sentry"],
      undefined,
    ]);
  });
});

describe("manifestErrors", () => {
  it("accepts a coherent multi-deployment manifest", () => {
    makeManifest(TWO_DEPLOYMENTS);
    expect(manifestErrors(parseManifest(deployDir))).toEqual([]);
  });

  it("reports two unnamed services of the same provider", () => {
    const service = { name: "github-app", provider: "github-app" };
    expect(manifestErrors(makeModel({ services: [service, service] }))).toEqual(
      [expect.stringMatching(/service name 'github-app'.*more than once/)],
    );
  });

  it("reports duplicate deployment names", () => {
    const deployment = { name: "vercel", provider: "vercel", targets: {} };
    expect(
      manifestErrors(makeModel({ deployments: [deployment, deployment] })),
    ).toEqual([
      expect.stringMatching(/deployment name 'vercel'.*more than once/),
    ]);
  });

  it("reports a reference to an undefined service", () => {
    const deployment = {
      name: "gate",
      provider: "vercel",
      targets: {},
      services: ["gate-ap"],
    };
    expect(manifestErrors(makeModel({ deployments: [deployment] }))).toEqual([
      "deployment 'gate' references undefined service 'gate-ap'.",
    ]);
  });

  it("reports a deployment scoped to an undeclared environment", () => {
    const deployment = {
      name: "gate",
      provider: "vercel",
      targets: {},
      environments: ["qa"],
    };
    expect(manifestErrors(makeModel({ deployments: [deployment] }))).toEqual([
      "deployment 'gate' is scoped to undeclared environment 'qa'.",
    ]);
  });
});

describe("soleDeployment", () => {
  it("returns the only deployment", () => {
    const deployment = { name: "gate", provider: "vercel", targets: {} };
    expect(soleDeployment(makeModel({ deployments: [deployment] }))).toBe(
      deployment,
    );
  });

  it("refuses several deployments, naming them", () => {
    makeManifest(TWO_DEPLOYMENTS);
    expect(() => soleDeployment(parseManifest(deployDir))).toThrow(
      /declares 2 deployments \(actor, gate\); select one with --deployment/,
    );
  });

  it("makes commands refuse a multi-deployment manifest", () => {
    makeManifest(TWO_DEPLOYMENTS);
    expect(() => resolveProjectDeployment(deployDir, workingDir)).toThrow(
      FatalError,
    );
  });

  it("makes env add refuse before writing the environment list", () => {
    makeManifest(TWO_DEPLOYMENTS);
    const envList = path.join(deployDir, "environments.yml");
    fs.writeFileSync(envList, "active:\n  - production\n");
    expect(() =>
      runEnvAdd({ workingDir }, ["qa", "--target", "preview"]),
    ).toThrow(FatalError);
    expect(fs.readFileSync(envList, "utf-8")).toBe("active:\n  - production\n");
  });
});

describe("check with named deployments", () => {
  it("requires each deployment of a multi-deployment root to pin its project", () => {
    makeManifest(TWO_DEPLOYMENTS);
    expect(checkStatic(workingDir).map((f) => f.message)).toEqual([
      expect.stringMatching(/Deployment 'actor' must pin its Vercel project/),
      expect.stringMatching(/Deployment 'gate' must pin its Vercel project/),
    ]);
  });

  it("reports manifestErrors as errors", () => {
    makeManifest([
      "environments: [production]",
      "services:",
      "  - provider: github-app",
      "  - provider: github-app",
      "deployments:",
      "  - provider: vercel",
      "    targets: { production: production }",
    ]);
    expect(
      checkStatic(workingDir)
        .filter((f) => f.severity === "error")
        .map((f) => f.message),
    ).toEqual([expect.stringMatching(/service name 'github-app'/)]);
  });
});
