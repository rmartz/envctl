import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parsePullArgs, runConfigPull } from "../lib/commands/config-pull";
import * as subprocess from "../lib/subprocess";

describe("config pull with a pinned project (#208)", () => {
  let workingDir: string;
  const ctx = () => ({ workingDir });

  beforeEach(() => {
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "envctl-pull-pin-"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(subprocess, "commandExists").mockReturnValue(true);
    vi.spyOn(subprocess, "runStatus").mockReturnValue({
      status: 0,
      stdout: "",
    });
    vi.stubEnv("VERCEL_PROJECT_ID", "");
    vi.stubEnv("VERCEL_TEAM_ID", "");
  });
  afterEach(() => {
    fs.rmSync(workingDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function makePinnedDir(dir: string, pin: string[]): void {
    fs.mkdirSync(path.join(workingDir, dir), { recursive: true });
    fs.writeFileSync(
      path.join(workingDir, dir, "manifest.yml"),
      [
        "environments: [production]",
        "deployments:",
        "  - provider: vercel",
        ...pin.map((line) => `    ${line}`),
        "    targets: { production: production }",
        "",
      ].join("\n"),
    );
  }

  it("resolves --deployment-dir against the project root", () => {
    expect(
      parsePullArgs(["--deployment-dir", "deployment/gate"], "/proj")
        .deploymentDir,
    ).toBe(path.join("/proj", "deployment", "gate"));
  });

  it("hands the pinned project to the Vercel CLI without a .vercel link", () => {
    makePinnedDir("deployment/gate", ["projectId: prj_gate", "teamId: team_x"]);
    const run = vi.spyOn(subprocess, "run").mockReturnValue("");
    runConfigPull(ctx(), [
      "--deployment-dir",
      "deployment/gate",
      "--env",
      "production",
    ]);
    expect(run.mock.calls[0]?.[2]?.env).toMatchObject({
      VERCEL_ORG_ID: "team_x",
      VERCEL_PROJECT_ID: "prj_gate",
    });
  });

  it("refuses, before running the CLI, when the link names another project", () => {
    makePinnedDir("deployment", ["projectId: prj_gate", "teamId: team_x"]);
    fs.mkdirSync(path.join(workingDir, ".vercel"));
    fs.writeFileSync(
      path.join(workingDir, ".vercel", "project.json"),
      JSON.stringify({ projectId: "prj_actor", orgId: "team_x" }),
    );
    const run = vi.spyOn(subprocess, "run").mockReturnValue("");
    expect(() => runConfigPull(ctx(), [])).toThrow(/names prj_actor/);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a pin with no resolvable team", () => {
    makePinnedDir("deployment", ["projectId: prj_gate"]);
    const run = vi.spyOn(subprocess, "run").mockReturnValue("");
    expect(() => runConfigPull(ctx(), [])).toThrow(/set teamId/);
    expect(run).not.toHaveBeenCalled();
  });
});
