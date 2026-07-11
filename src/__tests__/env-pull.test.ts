import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FatalError } from "../lib/logger";
import * as subprocess from "../lib/subprocess";
import { parsePullArgs, runEnvPull } from "../lib/commands/env-pull";

describe("parsePullArgs", () => {
  it("defaults to the development environment and .env.local", () => {
    const opts = parsePullArgs([], "/proj");
    expect(opts.env).toBe("development");
    expect(opts.out).toBe(path.join("/proj", ".env.local"));
  });

  it("honors --env and resolves --out against the project root", () => {
    const opts = parsePullArgs(
      ["--env", "staging", "--out", "local.env"],
      "/proj",
    );
    expect(opts.env).toBe("staging");
    expect(opts.out).toBe(path.join("/proj", "local.env"));
  });

  it("throws FatalError for an unknown flag", () => {
    expect(() => parsePullArgs(["--unknown"], "/proj")).toThrow(FatalError);
  });

  it("throws FatalError when --env has no following value", () => {
    expect(() => parsePullArgs(["--env"], "/proj")).toThrow(FatalError);
  });

  it("throws FatalError when --out has no following value", () => {
    expect(() => parsePullArgs(["--out"], "/proj")).toThrow(FatalError);
  });
});

describe("runEnvPull", () => {
  let workingDir: string;
  const ctx = () => ({ workingDir });

  beforeEach(() => {
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "envctl-pull-"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(subprocess, "commandExists").mockReturnValue(true);
  });
  afterEach(() => {
    fs.rmSync(workingDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function linkProject(): void {
    fs.mkdirSync(path.join(workingDir, ".vercel"));
    fs.writeFileSync(
      path.join(workingDir, ".vercel", "project.json"),
      '{"projectId":"p"}',
    );
  }

  it("invokes `vercel env pull` for the development target in the project dir", () => {
    linkProject();
    const run = vi.spyOn(subprocess, "run").mockReturnValue("");
    runEnvPull(ctx(), []);
    expect(run).toHaveBeenCalledWith(
      "vercel",
      [
        "env",
        "pull",
        path.join(workingDir, ".env.local"),
        "--environment=development",
        "--yes",
      ],
      expect.objectContaining({ cwd: workingDir }),
    );
  });

  it("maps the environment name to its Vercel target (staging -> preview)", () => {
    linkProject();
    const run = vi.spyOn(subprocess, "run").mockReturnValue("");
    runEnvPull(ctx(), ["--env", "staging", "--out", "s.env"]);
    expect(run).toHaveBeenCalledWith(
      "vercel",
      [
        "env",
        "pull",
        path.join(workingDir, "s.env"),
        "--environment=preview",
        "--yes",
      ],
      expect.objectContaining({ cwd: workingDir }),
    );
  });

  it("sets VERCEL_NON_INTERACTIVE=1 to prevent interactive prompts (e.g. overwrite)", () => {
    linkProject();
    const run = vi.spyOn(subprocess, "run").mockReturnValue("");
    runEnvPull(ctx(), []);
    expect(run.mock.calls[0][2]?.env).toMatchObject({
      VERCEL_NON_INTERACTIVE: "1",
    });
  });

  it("errors (and does not run vercel) when the Vercel CLI is absent", () => {
    linkProject();
    vi.spyOn(subprocess, "commandExists").mockReturnValue(false);
    const run = vi.spyOn(subprocess, "run").mockReturnValue("");
    expect(() => runEnvPull(ctx(), [])).toThrow(FatalError);
    expect(run).not.toHaveBeenCalled();
  });

  it("errors when the directory is not a linked Vercel project", () => {
    const run = vi.spyOn(subprocess, "run").mockReturnValue("");
    expect(() => runEnvPull(ctx(), [])).toThrow(FatalError);
    expect(run).not.toHaveBeenCalled();
  });
});
