import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { selectService } from "../lib/commands/service-select";
import type { DeploymentProvider } from "../lib/providers/deployment";
import { fanOutDeployment } from "../lib/providers/fan-out";
import { run } from "../lib/rotation";
import type { VercelEnvVar } from "../lib/vercel-api";

// An in-memory deployment provider: records writes and redeploys, and fails
// its redeploy when told to.
function makeFakeDeployment(
  name: string,
  failRedeploy = false,
): DeploymentProvider & { vars: Map<string, string>; redeployed: string[] } {
  const vars = new Map<string, string>();
  const redeployed: string[] = [];
  const records = (): VercelEnvVar[] =>
    [...vars].map(([k, value]) => {
      const [key = "", target = ""] = k.split("@");
      return {
        id: `${name}-${k}`,
        key,
        value,
        target: [target],
        type: "encrypted",
      };
    });
  return {
    vars,
    redeployed,
    provider: "vercel",
    projectId: `prj_${name}`,
    teamId: undefined,
    listEnvVars: () => Promise.resolve({ envs: records() }),
    getEnvVarValue: (id) =>
      Promise.resolve(records().find((r) => r.id === id)?.value ?? ""),
    findEnvVar: (envs, key, target) =>
      envs.find((e) => e.key === key && e.target.includes(target)),
    createEnvVar: (key, value, target) => {
      vars.set(`${key}@${target}`, value);
      return Promise.resolve(records().find((r) => r.key === key)!);
    },
    updateEnvVar: (existing, value) => {
      for (const t of existing.target) vars.set(`${existing.key}@${t}`, value);
      return Promise.resolve();
    },
    setEnvForTarget: (key, value, target) => {
      vars.set(`${key}@${target}`, value);
      return Promise.resolve(`${name}-${key}@${target}`);
    },
    removeEnvVarFromTarget: () => Promise.resolve(),
    triggerAndWaitRedeployments: (targetEnv) => {
      if (failRedeploy) return Promise.reject(new Error("deploy ERROR"));
      redeployed.push(targetEnv);
      return Promise.resolve();
    },
    refreshPreviewDeployments: () => Promise.resolve(),
  };
}

describe("fanOutDeployment", () => {
  it("writes one value to every project", async () => {
    const actor = makeFakeDeployment("actor");
    const gate = makeFakeDeployment("gate");
    const fan = fanOutDeployment({ name: "actor", deployment: actor }, [
      { name: "gate", deployment: gate },
    ]);
    await fan.setEnvForTarget("DSN", "new", "production", []);
    expect([
      actor.vars.get("DSN@production"),
      gate.vars.get("DSN@production"),
    ]).toEqual(["new", "new"]);
  });

  it("reads only from the primary", async () => {
    const actor = makeFakeDeployment("actor");
    const gate = makeFakeDeployment("gate");
    gate.vars.set("DSN@production", "gate-only");
    const fan = fanOutDeployment({ name: "actor", deployment: actor }, [
      { name: "gate", deployment: gate },
    ]);
    expect((await fan.listEnvVars()).envs).toEqual([]);
  });

  it("redeploys every project in order", async () => {
    const actor = makeFakeDeployment("actor");
    const gate = makeFakeDeployment("gate");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fan = fanOutDeployment({ name: "actor", deployment: actor }, [
      { name: "gate", deployment: gate },
    ]);
    await fan.triggerAndWaitRedeployments("production");
    expect([actor.redeployed, gate.redeployed]).toEqual([
      ["production"],
      ["production"],
    ]);
  });

  it("reports what was and wasn't redeployed when one fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fan = fanOutDeployment(
      { name: "actor", deployment: makeFakeDeployment("actor") },
      [
        { name: "gate", deployment: makeFakeDeployment("gate", true) },
        { name: "docs", deployment: makeFakeDeployment("docs") },
      ],
    );
    await expect(fan.triggerAndWaitRedeployments("production")).rejects.toThrow(
      /Redeploy failed for deployment 'gate'[\s\S]*Redeployed: actor\. Still to redeploy: gate, docs\./,
    );
  });
});

describe("shared-service rotation", () => {
  let workingDir: string;
  let root: string;
  let origEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    origEnv = { ...process.env };
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-rotation-"));
    root = path.join(workingDir, "deployment");
    fs.mkdirSync(root);
    process.env.VERCEL_TOKEN = "test-token";
    process.env.SENTRY_AUTH_TOKEN = "sentry-token";
    process.env.SENTRY_ORG = "acme";
    process.env.SENTRY_PROJECT = "web";
    delete process.env.VERCEL_PROJECT_ID;
    delete process.env.VERCEL_TEAM_ID;
    process.env.__VERCEL_CLI_AUTH_PATH = path.join(workingDir, "none.json");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = origEnv;
    fs.rmSync(workingDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeRoot(extra: string[] = []): void {
    fs.writeFileSync(
      path.join(root, "manifest.yml"),
      [
        "environments: [production]",
        "services:",
        "  - provider: sentry",
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
        ...extra,
      ].join("\n") + "\n",
    );
  }

  async function mockSentryProject(failSecondRedeploy: boolean) {
    const subprocess = await import("../lib/subprocess");
    vi.spyOn(subprocess, "commandExists").mockReturnValue(true);
    vi.spyOn(subprocess, "run").mockReturnValue("rmartz");
    const { VercelClient } = await import("../lib/vercel-api");
    vi.spyOn(VercelClient.prototype, "listEnvVars").mockResolvedValue({
      envs: [
        {
          id: "dsn",
          key: "NEXT_PUBLIC_SENTRY_DSN",
          value: "old",
          target: ["production"],
          type: "encrypted",
        },
      ],
      pagination: undefined,
    });
    const deployments = await import("../lib/deployments");
    const redeploy = vi.spyOn(deployments, "triggerAndWaitRedeployments");
    redeploy.mockResolvedValueOnce(undefined);
    if (failSecondRedeploy)
      redeploy.mockRejectedValueOnce(new Error("deploy ERROR"));
    else redeploy.mockResolvedValueOnce(undefined);
    const sentry = await import("../lib/sentry");
    return {
      rotate: vi.spyOn(sentry, "rotateSentry").mockResolvedValue("old-key"),
      invalidate: vi
        .spyOn(sentry, "invalidateSentryKey")
        .mockResolvedValue(undefined),
      redeploy,
    };
  }

  const runShared = () =>
    run({
      targetEnv: "production",
      invalidateKeys: true,
      workingDir,
      deploymentDir: path.join(root, "actor"),
      sharedDeploymentDirs: [path.join(root, "gate")],
      provider: "sentry",
    });

  it("mints once and invalidates after every project is redeployed", async () => {
    makeRoot();
    const mocks = await mockSentryProject(false);
    await runShared();
    expect([
      mocks.rotate.mock.calls.length,
      mocks.redeploy.mock.calls.length,
      mocks.invalidate.mock.calls.length,
    ]).toEqual([1, 2, 1]);
  });

  it("invalidates nothing when the second project's redeploy fails", async () => {
    makeRoot();
    const mocks = await mockSentryProject(true);
    await expect(runShared()).rejects.toThrow(
      /Redeploy failed for deployment 'gate'/,
    );
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it("refuses a shared GitHub App", () => {
    makeRoot();
    fs.writeFileSync(
      path.join(root, "manifest.yml"),
      fs
        .readFileSync(path.join(root, "manifest.yml"), "utf-8")
        .replace("  - provider: sentry", "  - provider: github-app"),
    );
    expect(() => selectService(root, root, false, "github-app")).toThrow(
      /an App has one webhook URL/,
    );
  });

  it("refuses sharers whose environments map to different targets", () => {
    makeRoot();
    fs.writeFileSync(
      path.join(root, "manifest.yml"),
      fs
        .readFileSync(path.join(root, "manifest.yml"), "utf-8")
        .replace(
          "environments: [production]",
          "environments: [production, staging]",
        )
        .replace(
          "    projectId: prj_gate\n    teamId: team_x\n    targets: { production: production }",
          "    projectId: prj_gate\n    teamId: team_x\n    targets: { production: production, staging: production }",
        ),
    );
    expect(() => selectService(root, root, false, "sentry")).toThrow(
      /map their environments to different targets/,
    );
  });
});
