import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { declaredByEnv } from "../../lib/check-completeness";
import { checkForeignServiceVars } from "../../lib/check-services";
import { parseSecretsArgs } from "../../lib/commands/secrets-args";
import {
  assertNoSharedRotation,
  selectService,
} from "../../lib/commands/service-select";
import { resolveFirebaseCredential } from "../../lib/firebase-credential";
import {
  deploymentsReached,
  manifestErrors,
  parseManifest,
  sharedServices,
  type DeploymentDecl,
} from "../../lib/manifest";
import type { DeploymentProvider } from "../../lib/providers/deployment";
import { serviceVarCollisions } from "../../lib/service-vars";
import { envTargetResolver } from "../../lib/targets";
import type { VercelEnvVar } from "../../lib/vercel-api";

let workingDir: string;
let root: string;

beforeEach(() => {
  workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "service-routing-"));
  root = path.join(workingDir, "deployment");
  fs.mkdirSync(root);
});

afterEach(() => {
  fs.rmSync(workingDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function makeRoot(lines: string[]): void {
  fs.writeFileSync(path.join(root, "manifest.yml"), lines.join("\n") + "\n");
}

// Actor and gate share sentry; each has its own App.
const ROOT = [
  "environments: [production]",
  "services:",
  "  - provider: sentry",
  "  - name: actor-app",
  "    provider: github-app",
  "    variables: { privateKey: ACTOR_KEY, webhookSecret: ACTOR_SECRET }",
  "  - name: gate-app",
  "    provider: github-app",
  "    variables: { privateKey: GATE_KEY, webhookSecret: GATE_SECRET }",
  "deployments:",
  "  - name: actor",
  "    provider: vercel",
  "    projectId: prj_actor",
  "    teamId: team_x",
  "    services: [actor-app, sentry]",
  "    targets: { production: production }",
  "  - name: gate",
  "    provider: vercel",
  "    projectId: prj_gate",
  "    teamId: team_x",
  "    services: [gate-app, sentry]",
  "    targets: { production: production }",
];

const deploymentNamed = (name: string): DeploymentDecl => {
  const found = parseManifest(root).deployments.find((d) => d.name === name);
  if (!found) throw new Error(`no deployment ${name}`);
  return found;
};

const liveVar = (key: string): VercelEnvVar => ({
  id: `id-${key}`,
  key,
  value: "x",
  target: ["production"],
  type: "encrypted",
});

describe("routing services to deployments", () => {
  it("finds the deployments that list a service", () => {
    makeRoot(ROOT);
    expect(
      deploymentsReached(parseManifest(root), "sentry").map((d) => d.name),
    ).toEqual(["actor", "gate"]);
  });

  it("reports the services a deployment shares, with whom", () => {
    makeRoot(ROOT);
    expect(
      sharedServices(parseManifest(root), deploymentNamed("gate")).map((s) => [
        s.service.name,
        s.with,
      ]),
    ).toEqual([["sentry", ["actor"]]]);
  });

  it("errors when a deployment receives two services of one provider", () => {
    makeRoot(
      ROOT.map((line) =>
        line.replace("[gate-app, sentry]", "[gate-app, actor-app]"),
      ),
    );
    expect(manifestErrors(parseManifest(root))).toEqual([
      "deployment 'gate' receives more than one github-app service (actor-app, gate-app) — list only one in its services.",
    ]);
  });

  it("reports two providers writing one variable on a deployment", () => {
    makeRoot([
      "environments: [production]",
      "services:",
      "  - provider: firebase",
      "    variables: { privateKey: SHARED_KEY }",
      "  - provider: github-app",
      "    variables: { privateKey: SHARED_KEY }",
      "deployments:",
      "  - provider: vercel",
      "    targets: { production: production }",
    ]);
    expect(serviceVarCollisions(parseManifest(root))).toEqual([
      expect.stringMatching(
        /services 'firebase' and 'github-app' both write SHARED_KEY/,
      ),
    ]);
  });
});

describe("selecting a service on the command line", () => {
  it("picks the one deployment that lists a service, by name", () => {
    makeRoot(ROOT);
    expect(selectService(root, root, false, "gate-app")).toEqual({
      deploymentDir: path.join(root, "gate"),
      provider: "github-app",
    });
  });

  it("refuses a service several deployments share", () => {
    makeRoot(ROOT);
    expect(() => selectService(root, root, false, "sentry")).toThrow(
      /'sentry' is shared by deployments actor, gate/,
    );
  });

  it("asks for a name when a provider has several services", () => {
    makeRoot(ROOT);
    expect(() => selectService(root, root, false, "github-app")).toThrow(
      /Several github-app services are declared \(actor-app, gate-app\)/,
    );
  });

  it("refuses a service the chosen deployment doesn't receive", () => {
    makeRoot(ROOT);
    const gate = path.join(root, "gate");
    expect(() => selectService(root, gate, true, "actor-app")).toThrow(
      /No service 'actor-app' reaches this deployment/,
    );
  });

  it("routes `secrets rotate gate-app` to the gate deployment", () => {
    makeRoot(ROOT);
    const opts = parseSecretsArgs(["gate-app"], workingDir, false);
    expect([opts.deploymentDir, opts.provider]).toEqual([
      path.join(root, "gate"),
      "github-app",
    ]);
  });

  it("keeps a provider keyword as before on a single deployment", () => {
    fs.writeFileSync(path.join(root, "environments.yml"), "active: [prod]\n");
    expect(parseSecretsArgs(["sentry"], workingDir, true).init).toBe("sentry");
  });
});

describe("rotating a shared service", () => {
  it("refuses an unscoped rotation that would include it", () => {
    makeRoot(ROOT);
    expect(() =>
      assertNoSharedRotation(path.join(root, "gate"), undefined),
    ).toThrow(/'sentry' \(shared with actor\)/);
  });

  it("allows rotating a service only this deployment uses", () => {
    makeRoot(ROOT);
    expect(() =>
      assertNoSharedRotation(path.join(root, "gate"), "github-app"),
    ).not.toThrow();
  });
});

describe("check --live service ownership", () => {
  it("flags another deployment's App key on this project", () => {
    makeRoot(ROOT);
    const live = [liveVar("GATE_KEY"), liveVar("ACTOR_KEY")];
    expect(
      checkForeignServiceVars(
        parseManifest(root),
        deploymentNamed("gate"),
        new Set(),
        live,
      ).map((f) => f.message),
    ).toEqual([
      "deployment 'gate' holds ACTOR_KEY, which belongs to service 'actor-app' that it doesn't list — remove it from the project.",
    ]);
  });

  it("doesn't treat a view as legacy, so other providers' vars aren't tolerated", () => {
    makeRoot(ROOT);
    const gate = path.join(root, "gate");
    const manifest = parseManifest(gate);
    const [production] = declaredByEnv(
      gate,
      manifest,
      {
        targetEnv: "all",
        deployment: {} as DeploymentProvider,
        tempDir: "",
        firebaseCredential: resolveFirebaseCredential(undefined),
      },
      envTargetResolver(gate),
    );
    expect(production?.known.has("FIREBASE_PRIVATE_KEY")).toBe(false);
  });
});
