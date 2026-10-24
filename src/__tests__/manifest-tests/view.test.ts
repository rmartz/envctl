import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkStatic } from "../../lib/check";
import { parsePushArgs } from "../../lib/commands/config-push-args";
import { resolveDeploymentDir } from "../../lib/commands/deployment-select";
import { assertDeploymentPrereqs } from "../../lib/commands/env-plan";
import {
  assertServiceListed,
  detectConfiguredServices,
} from "../../lib/commands/secrets-plan";
import { listActiveEnvs, parseDeploymentEnv } from "../../lib/environments";
import { FatalError } from "../../lib/logger";
import { deploymentView, parseManifest, publicVars } from "../../lib/manifest";
import { detectProject } from "../../lib/project";

let workingDir: string;
let root: string;

beforeEach(() => {
  workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "deployment-view-"));
  root = path.join(workingDir, "deployment");
  fs.mkdirSync(root);
  vi.stubEnv("VERCEL_PROJECT_ID", "");
  vi.stubEnv("VERCEL_TEAM_ID", "");
});

afterEach(() => {
  fs.rmSync(workingDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function makeRoot(lines: string[]): void {
  fs.writeFileSync(path.join(root, "manifest.yml"), lines.join("\n") + "\n");
}

function makeOverlay(rel: string, lines: string[]): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

// Actor and gate share sentry and a top-level variable; each has its own App.
const ROOT = [
  "environments: [production, staging]",
  "services:",
  "  - provider: sentry",
  "  - name: actor-app",
  "    provider: github-app",
  "  - name: gate-app",
  "    provider: github-app",
  "variables:",
  "  SHARED: { value: top }",
  "  PR_APP_ROLE: { value: unset }",
  "deployments:",
  "  - name: actor",
  "    provider: vercel",
  "    projectId: prj_actor",
  "    teamId: team_x",
  "    services: [actor-app, sentry]",
  "    targets: { production: production, staging: preview }",
  "  - name: gate",
  "    provider: vercel",
  "    projectId: prj_gate",
  "    teamId: team_x",
  "    services: [gate-app]",
  "    environments: [production]",
  "    targets: { production: production }",
  "    variables:",
  "      PR_APP_ROLE: { value: gate }",
];

const gateDir = (): string => path.join(root, "gate");
const actorDir = (): string => path.join(root, "actor");

describe("deployment views", () => {
  it("resolves a dir without config of its own to the parent's deployment", () => {
    makeRoot(ROOT);
    expect(deploymentView(gateDir())?.deployment.name).toBe("gate");
  });

  it("is not a view when the dir holds its own manifest", () => {
    makeRoot(ROOT);
    makeOverlay("gate/manifest.yml", ["environments: [production]"]);
    expect(deploymentView(gateDir())).toBeUndefined();
  });

  it("is not a view for a name the parent doesn't declare", () => {
    makeRoot(ROOT);
    expect(deploymentView(path.join(root, "nope"))).toBeUndefined();
  });

  it("narrows services to those the deployment lists", () => {
    makeRoot(ROOT);
    expect(parseManifest(gateDir()).services.map((s) => s.name)).toEqual([
      "gate-app",
    ]);
  });

  it("merges variables, the deployment's winning on a clash", () => {
    makeRoot(ROOT);
    expect(parseManifest(gateDir()).variables).toEqual([
      { name: "SHARED", source: { kind: "value", value: "top" } },
      { name: "PR_APP_ROLE", source: { kind: "value", value: "gate" } },
    ]);
  });

  it("uses the deployment's environments, else the root's", () => {
    makeRoot(ROOT);
    expect([listActiveEnvs(gateDir()), listActiveEnvs(actorDir())]).toEqual([
      ["production"],
      ["production", "staging"],
    ]);
  });

  it("layers the deployment's overlay over the shared one", () => {
    makeRoot(ROOT);
    makeOverlay("production.yml", ["A: shared", "B: shared"]);
    makeOverlay("gate/production.yml", ["B: gate"]);
    expect(parseDeploymentEnv(gateDir(), "production")).toEqual({
      A: "shared",
      B: "gate",
    });
  });

  it("refuses a view of a structurally invalid root", () => {
    makeRoot([...ROOT, "  - name: gate", "    provider: vercel"]);
    expect(() => parseManifest(gateDir())).toThrow(/manifest .* is invalid/);
  });
});

describe("selecting a deployment", () => {
  it("resolves --deployment to the view dir", () => {
    makeRoot(ROOT);
    expect(resolveDeploymentDir(workingDir, "deployment", "gate")).toBe(
      gateDir(),
    );
  });

  it("lists the declared names for an unknown deployment", () => {
    makeRoot(ROOT);
    expect(() =>
      resolveDeploymentDir(workingDir, "deployment", "gaet"),
    ).toThrow(/No deployment named 'gaet'.*Declared: actor, gate/);
  });

  it("refuses a name that would leave the deployment dir", () => {
    makeRoot(ROOT);
    expect(() => resolveDeploymentDir(workingDir, "deployment", "..")).toThrow(
      FatalError,
    );
  });

  it("tells a command run on the root to select a deployment", () => {
    makeRoot(ROOT);
    expect(() => assertDeploymentPrereqs(root, "token")).toThrow(
      /declares 2 deployments \(actor, gate\); select one with --deployment/,
    );
  });

  it("accepts --deployment on config push", () => {
    makeRoot(ROOT);
    expect(
      parsePushArgs(["--deployment", "gate"], workingDir).deploymentDir,
    ).toBe(gateDir());
  });
});

describe("routing services and projects through a view", () => {
  it("resolves each view to its own pinned project", () => {
    makeRoot(ROOT);
    expect([
      detectProject(workingDir, gateDir()).projectId,
      detectProject(workingDir, actorDir()).projectId,
    ]).toEqual(["prj_gate", "prj_actor"]);
  });

  it("refuses an unpinned deployment that shares its manifest", () => {
    makeRoot(ROOT.filter((line) => !line.includes("prj_gate")));
    expect(() => detectProject(workingDir, gateDir())).toThrow(
      /Deployment 'gate' must pin its Vercel project/,
    );
  });

  it("doesn't detect a shared-overlay service the deployment doesn't list", () => {
    makeRoot(ROOT);
    makeOverlay("production.yml", ["SENTRY_ORG: acme", "SENTRY_PROJECT: web"]);
    expect(
      detectConfiguredServices(
        gateDir(),
        "production",
        ["production"],
        undefined,
      ).sentry,
    ).toBe(false);
  });

  it("still detects it for a deployment that lists it", () => {
    makeRoot(ROOT);
    makeOverlay("production.yml", ["SENTRY_ORG: acme", "SENTRY_PROJECT: web"]);
    expect(
      detectConfiguredServices(
        actorDir(),
        "production",
        ["production"],
        undefined,
      ).sentry,
    ).toBe(true);
  });

  it("refuses a named provider the deployment doesn't list", () => {
    makeRoot(ROOT);
    expect(() => assertServiceListed(gateDir(), "sentry")).toThrow(
      /Deployment 'gate' doesn't list a sentry service/,
    );
  });
});

describe("publicVars", () => {
  it("pushes the deployment's literal values under its overlay", () => {
    makeRoot(ROOT);
    makeOverlay("gate/production.yml", ["SHARED: overridden"]);
    expect(publicVars(parseManifest(gateDir()), "production")).toEqual({
      SHARED: "overridden",
      PR_APP_ROLE: "gate",
    });
  });

  it("never pushes a generated variable's overlay value", () => {
    makeRoot([
      "environments: [production]",
      "variables:",
      "  CRON_SECRET: { generate: true }",
      "  SITE: { value: home }",
    ]);
    makeOverlay("production.yml", ["CRON_SECRET: leaked"]);
    expect(publicVars(parseManifest(root), "production")).toEqual({
      SITE: "home",
    });
  });
});

describe("check on a multi-deployment root", () => {
  it("passes when every deployment is pinned and resolves", () => {
    makeRoot(ROOT);
    expect(checkStatic(workingDir)).toEqual([]);
  });

  it("prefixes a per-deployment finding with its deployment", () => {
    makeRoot(
      ROOT.map((line) => line.replace("staging: preview", "staging: qa")),
    );
    expect(checkStatic(workingDir).map((f) => f.message)).toContainEqual(
      expect.stringMatching(/^deployment 'actor': environment 'staging'/),
    );
  });
});
