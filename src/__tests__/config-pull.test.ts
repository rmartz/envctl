import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FatalError } from "../lib/logger";
import * as subprocess from "../lib/subprocess";
import {
  parsePullArgs,
  runConfigPull,
  runEnvPullDeprecated,
} from "../lib/commands/config-pull";

describe("parsePullArgs", () => {
  it("defaults to the development environment, .env.local, and no force", () => {
    const opts = parsePullArgs([], "/proj");
    expect(opts.env).toBe("development");
    expect(opts.out).toBe(path.join("/proj", ".env.local"));
    expect(opts.force).toBe(false);
  });

  it("honors --env and resolves --out against the project root", () => {
    const opts = parsePullArgs(
      ["--env", "staging", "--out", "local.env"],
      "/proj",
    );
    expect(opts.env).toBe("staging");
    expect(opts.out).toBe(path.join("/proj", "local.env"));
  });

  it("--force sets force", () => {
    expect(parsePullArgs(["--force"], "/proj").force).toBe(true);
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

describe("runConfigPull", () => {
  let workingDir: string;
  const ctx = () => ({ workingDir });

  beforeEach(() => {
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "envctl-pull-"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(subprocess, "commandExists").mockReturnValue(true);
    // Default: the target is gitignored, so no advisory fires.
    vi.spyOn(subprocess, "runStatus").mockReturnValue({
      status: 0,
      stdout: "",
    });
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
    runConfigPull(ctx(), []);
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
    runConfigPull(ctx(), ["--env", "staging", "--out", "s.env"]);
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
    runConfigPull(ctx(), []);
    expect(run.mock.calls[0][2]?.env).toMatchObject({
      VERCEL_NON_INTERACTIVE: "1",
    });
  });

  it("errors (and does not run vercel) when the Vercel CLI is absent", () => {
    linkProject();
    vi.spyOn(subprocess, "commandExists").mockReturnValue(false);
    const run = vi.spyOn(subprocess, "run").mockReturnValue("");
    expect(() => runConfigPull(ctx(), [])).toThrow(FatalError);
    expect(run).not.toHaveBeenCalled();
  });

  it("errors when the directory is not a linked Vercel project", () => {
    const run = vi.spyOn(subprocess, "run").mockReturnValue("");
    expect(() => runConfigPull(ctx(), [])).toThrow(FatalError);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses to overwrite an existing target without --force", () => {
    linkProject();
    fs.writeFileSync(path.join(workingDir, ".env.local"), "OLD=1\n");
    const run = vi.spyOn(subprocess, "run").mockReturnValue("");
    expect(() => runConfigPull(ctx(), [])).toThrow(FatalError);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses to write when the target is a dangling symlink (bypasses existsSync)", () => {
    linkProject();
    const out = path.join(workingDir, ".env.local");
    fs.symlinkSync(path.join(workingDir, "nonexistent"), out);
    const run = vi.spyOn(subprocess, "run").mockReturnValue("");
    expect(() => runConfigPull(ctx(), [])).toThrow(FatalError);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses to write when the target path is a non-regular file", () => {
    linkProject();
    const out = path.join(workingDir, ".env.local");
    fs.mkdirSync(out);
    const run = vi.spyOn(subprocess, "run").mockReturnValue("");
    expect(() => runConfigPull(ctx(), [])).toThrow(FatalError);
    expect(run).not.toHaveBeenCalled();
  });

  it("overwrites an existing target when --force is given", () => {
    linkProject();
    fs.writeFileSync(path.join(workingDir, ".env.local"), "OLD=1\n");
    const run = vi.spyOn(subprocess, "run").mockReturnValue("");
    runConfigPull(ctx(), ["--force"]);
    expect(run).toHaveBeenCalledOnce();
  });

  it("restricts the written file to owner-only (0600) because it holds secrets", () => {
    linkProject();
    const out = path.join(workingDir, ".env.local");
    // The CLI is mocked, so emulate its write (world-readable) here.
    vi.spyOn(subprocess, "run").mockImplementation(() => {
      fs.writeFileSync(out, "SECRET=1\n", { mode: 0o644 });
      return "";
    });
    runConfigPull(ctx(), []);
    expect(fs.statSync(out).mode & 0o777).toBe(0o600);
  });

  it("warns when the target is not gitignored", () => {
    linkProject();
    vi.spyOn(subprocess, "run").mockReturnValue("");
    vi.spyOn(subprocess, "runStatus").mockReturnValue({
      status: 1,
      stdout: "",
    });
    const error = vi.spyOn(console, "error");
    runConfigPull(ctx(), []);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("not gitignored"),
    );
  });

  it("does not warn about gitignore when the target is ignored", () => {
    linkProject();
    vi.spyOn(subprocess, "run").mockReturnValue("");
    const error = vi.spyOn(console, "error");
    runConfigPull(ctx(), []);
    expect(error).not.toHaveBeenCalledWith(
      expect.stringContaining("not gitignored"),
    );
  });

  describe("runEnvPullDeprecated (env pull alias)", () => {
    it("warns about deprecation and delegates to config pull", () => {
      linkProject();
      const run = vi.spyOn(subprocess, "run").mockReturnValue("");
      const error = vi.spyOn(console, "error");
      runEnvPullDeprecated(ctx(), []);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("deprecated"));
      expect(run).toHaveBeenCalledOnce();
    });
  });
});
