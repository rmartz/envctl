import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  pushSharedGeneratedSecrets,
  splitSharedGenerated,
  type SharedGeneratedMember,
} from "../lib/generated-shared";
import { resolveGeneratedSecrets } from "../lib/generated-secrets";
import type { DeploymentProvider } from "../lib/providers/deployment";
import type { VercelEnvVar } from "../lib/vercel-api";

// An in-memory deployment holding `key@target` → value.
function makeFakeDeployment(
  name: string,
  initial: Record<string, string> = {},
  readable = true,
): DeploymentProvider & { vars: Map<string, string> } {
  const vars = new Map(Object.entries(initial));
  const records = (): VercelEnvVar[] =>
    [...vars].map(([k, value]) => {
      const [key = "", target = ""] = k.split("@");
      return {
        id: `${name}:${k}`,
        key,
        value,
        target: [target],
        type: "encrypted",
      };
    });
  const unused = (): never => {
    throw new Error("unused");
  };
  return {
    vars,
    provider: "vercel",
    projectId: `prj_${name}`,
    teamId: undefined,
    listEnvVars: () => Promise.resolve({ envs: records() }),
    getEnvVarValue: (id) =>
      Promise.resolve(
        readable ? (records().find((r) => r.id === id)?.value ?? "") : "",
      ),
    findEnvVar: (envs, key, target) =>
      envs.find((e) => e.key === key && e.target.includes(target)),
    createEnvVar: unused,
    updateEnvVar: unused,
    setEnvForTarget: (key, value, target) => {
      vars.set(`${key}@${target}`, value);
      return Promise.resolve(`${name}:${key}@${target}`);
    },
    removeEnvVarFromTarget: unused,
    triggerAndWaitRedeployments: unused,
    refreshPreviewDeployments: unused,
  };
}

const member = (
  name: string,
  deployment: DeploymentProvider,
  targets = ["production"],
): SharedGeneratedMember => ({
  name,
  deployment,
  secrets: [{ name: "CRON_SECRET", targets }],
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("pushSharedGeneratedSecrets", () => {
  it("mints one value for every deployment on init", async () => {
    const actor = makeFakeDeployment("actor");
    const gate = makeFakeDeployment("gate");
    await pushSharedGeneratedSecrets(
      [member("actor", actor), member("gate", gate)],
      ["CRON_SECRET"],
      { overwrite: false, targetEnv: "all" },
    );
    const actorValue = actor.vars.get("CRON_SECRET@production");
    expect(gate.vars.get("CRON_SECRET@production")).toBe(actorValue);
  });

  it("copies a value a sibling already holds on init", async () => {
    const actor = makeFakeDeployment("actor");
    const gate = makeFakeDeployment("gate", {
      "CRON_SECRET@production": "held-by-gate",
    });
    await pushSharedGeneratedSecrets(
      [member("actor", actor), member("gate", gate)],
      ["CRON_SECRET"],
      { overwrite: false, targetEnv: "all" },
    );
    expect(actor.vars.get("CRON_SECRET@production")).toBe("held-by-gate");
  });

  it("reports only the deployments it wrote to", async () => {
    const written = await pushSharedGeneratedSecrets(
      [
        member("actor", makeFakeDeployment("actor")),
        member(
          "gate",
          makeFakeDeployment("gate", { "CRON_SECRET@production": "held" }),
        ),
      ],
      ["CRON_SECRET"],
      { overwrite: false, targetEnv: "all" },
    );
    expect([...written]).toEqual(["actor"]);
  });

  it("writes one fresh value everywhere on rotate", async () => {
    const actor = makeFakeDeployment("actor", {
      "CRON_SECRET@production": "a",
    });
    const gate = makeFakeDeployment("gate", { "CRON_SECRET@production": "b" });
    await pushSharedGeneratedSecrets(
      [member("actor", actor), member("gate", gate)],
      ["CRON_SECRET"],
      { overwrite: true, targetEnv: "all" },
    );
    const value = actor.vars.get("CRON_SECRET@production");
    expect([value === "a", gate.vars.get("CRON_SECRET@production")]).toEqual([
      false,
      value,
    ]);
  });

  it("writes a target only to deployments whose secret covers it", async () => {
    const actor = makeFakeDeployment("actor");
    const gate = makeFakeDeployment("gate");
    await pushSharedGeneratedSecrets(
      [member("actor", actor, ["production", "preview"]), member("gate", gate)],
      ["CRON_SECRET"],
      { overwrite: false, targetEnv: "all" },
    );
    expect(gate.vars.has("CRON_SECRET@preview")).toBe(false);
  });

  it("refuses to copy a value it can't read", async () => {
    const gate = makeFakeDeployment(
      "gate",
      { "CRON_SECRET@production": "sensitive" },
      false,
    );
    await expect(
      pushSharedGeneratedSecrets(
        [member("actor", makeFakeDeployment("actor")), member("gate", gate)],
        ["CRON_SECRET"],
        { overwrite: false, targetEnv: "all" },
      ),
    ).rejects.toThrow(/Can't read the shared generated secret CRON_SECRET/);
  });
});

describe("splitSharedGenerated", () => {
  let workingDir: string;
  let root: string;

  beforeEach(() => {
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "generated-shared-"));
    root = path.join(workingDir, "deployment");
    fs.mkdirSync(root);
    vi.stubEnv("VERCEL_TOKEN", "test-token");
    vi.stubEnv("VERCEL_PROJECT_ID", "");
    fs.writeFileSync(
      path.join(root, "manifest.yml"),
      [
        "environments: [production]",
        "variables:",
        "  CRON_SECRET: { generate: true }",
        "deployments:",
        "  - name: actor",
        "    provider: vercel",
        "    projectId: prj_actor",
        "    teamId: team_x",
        "    targets: { production: production }",
        "  - name: gate",
        "    provider: vercel",
        "    projectId: prj_gate",
        "    teamId: team_x",
        "    targets: { production: production }",
        "    variables:",
        "      GATE_TOKEN: { generate: true }",
      ].join("\n") + "\n",
    );
  });
  afterEach(() => {
    fs.rmSync(workingDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("shares root variables and keeps deployment-scoped ones", () => {
    const gateDir = path.join(root, "gate");
    const split = splitSharedGenerated(
      gateDir,
      workingDir,
      makeFakeDeployment("gate"),
      resolveGeneratedSecrets(gateDir),
    );
    expect([split.shared, split.own.map((s) => s.name)]).toEqual([
      ["CRON_SECRET"],
      ["GATE_TOKEN"],
    ]);
  });

  it("puts the run's own deployment first, with each sibling pinned", () => {
    const gateDir = path.join(root, "gate");
    const split = splitSharedGenerated(
      gateDir,
      workingDir,
      makeFakeDeployment("gate"),
      resolveGeneratedSecrets(gateDir),
    );
    expect(split.members.map((m) => [m.name, m.deployment.projectId])).toEqual([
      ["gate", "prj_gate"],
      ["actor", "prj_actor"],
    ]);
  });
});
