import * as path from "path";

import { describe, expect, it, vi } from "vitest";

import { parsePushArgs } from "../lib/commands/config-push-args";
import { FatalError } from "../lib/logger";

// ─── parsePushArgs ────────────────────────────────────────────────────────────

describe("parsePushArgs", () => {
  const root = "/proj";

  it("returns defaults when no args given", () => {
    expect(parsePushArgs([], root)).toEqual({
      targetEnv: "all",
      workingDir: root,
      deploymentDir: path.resolve(root, "deployment"),
      dryRun: false,
    });
  });

  it("--env sets targetEnv", () => {
    expect(parsePushArgs(["--env", "staging"], root).targetEnv).toBe("staging");
  });

  it("--deployment-dir resolves a relative path against the project root", () => {
    expect(
      parsePushArgs(["--deployment-dir", "infra/deploy"], root).deploymentDir,
    ).toBe(path.resolve(root, "infra/deploy"));
  });

  it("--deployment-dir keeps an absolute path", () => {
    expect(
      parsePushArgs(["--deployment-dir", "/abs/deploy"], root).deploymentDir,
    ).toBe("/abs/deploy");
  });

  it("--dry-run sets dryRun", () => {
    expect(parsePushArgs(["--dry-run"], root).dryRun).toBe(true);
  });

  it("threads workingDir through to options", () => {
    expect(parsePushArgs([], "/elsewhere").workingDir).toBe("/elsewhere");
  });

  it("throws FatalError on an unknown flag", () => {
    expect(() => parsePushArgs(["--bogus"], root)).toThrow(FatalError);
    expect(() => parsePushArgs(["--bogus"], root)).toThrow("Unknown option");
  });

  it("throws FatalError when --env is missing its value", () => {
    expect(() => parsePushArgs(["--env"], root)).toThrow(FatalError);
  });

  it("throws FatalError when --deployment-dir is missing its value", () => {
    expect(() => parsePushArgs(["--deployment-dir"], root)).toThrow(FatalError);
  });

  it("prints usage and exits 0 for --help", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(() => parsePushArgs(["--help"], root)).toThrow("process.exit");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    exit.mockRestore();
    log.mockRestore();
  });

  it("prints usage and exits 0 for -h", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(() => parsePushArgs(["-h"], root)).toThrow("process.exit");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    exit.mockRestore();
    log.mockRestore();
  });
});
