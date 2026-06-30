import * as path from "path";

import { describe, expect, it, vi } from "vitest";

import { FatalError } from "../lib/logger";
import { renderGroupHelp, renderTopHelp } from "../lib/cli/help";
import type { CommandGroup, Registry } from "../lib/cli/registry";
import { extractGlobalArgs, route } from "../lib/cli/router";
import { readPackageVersion } from "../lib/cli/version";

const run = vi.fn();

const configGroup: CommandGroup = {
  name: "config",
  summary: "Manage environment variables",
  commands: [{ name: "push", summary: "Push public vars", run }],
};
const registry: Registry = [configGroup];

describe("extractGlobalArgs — global flag handling", () => {
  it("defaults the working directory to the given CWD", () => {
    const { workingDir, rest } = extractGlobalArgs(["config", "push"], "/cwd");
    expect(workingDir).toBe("/cwd");
    expect(rest).toEqual(["config", "push"]);
  });

  it("resolves -C <dir> against the CWD and strips it from the rest", () => {
    const { workingDir, rest } = extractGlobalArgs(
      ["-C", "../proj", "config", "push"],
      "/home/cwd",
    );
    expect(workingDir).toBe(path.resolve("/home/cwd", "../proj"));
    expect(rest).toEqual(["config", "push"]);
  });

  it("accepts --working-dir anywhere in argv", () => {
    const { workingDir, rest } = extractGlobalArgs(
      ["config", "--working-dir", "/abs/proj", "push"],
      "/cwd",
    );
    expect(workingDir).toBe("/abs/proj");
    expect(rest).toEqual(["config", "push"]);
  });

  it("throws a FatalError when -C has no value", () => {
    expect(() => extractGlobalArgs(["-C"], "/cwd")).toThrow(FatalError);
  });
});

describe("route — route parsing", () => {
  it("returns top-level help when no tokens are given", () => {
    expect(route([], registry)).toEqual({ kind: "help" });
  });

  it("returns top-level help for -h / --help", () => {
    expect(route(["-h"], registry)).toEqual({ kind: "help" });
    expect(route(["--help"], registry)).toEqual({ kind: "help" });
  });

  it("returns version for --version", () => {
    expect(route(["--version"], registry)).toEqual({ kind: "version" });
  });

  it("returns group help for <group> and <group> --help", () => {
    expect(route(["config"], registry)).toEqual({
      kind: "help",
      group: configGroup,
    });
    expect(route(["config", "--help"], registry)).toEqual({
      kind: "help",
      group: configGroup,
    });
  });

  it("routes <group> <command> to run with the remaining args", () => {
    const result = route(["config", "push", "--env", "staging"], registry);
    expect(result).toEqual({
      kind: "run",
      group: configGroup,
      command: configGroup.commands[0],
      args: ["--env", "staging"],
    });
  });

  it("errors on an unknown group", () => {
    expect(route(["bogus"], registry)).toEqual({
      kind: "error",
      message: "unknown command: bogus",
    });
  });

  it("errors on an unknown command within a known group", () => {
    expect(route(["config", "bogus"], registry)).toEqual({
      kind: "error",
      message: "unknown command: config bogus",
    });
  });
});

describe("help rendering", () => {
  it("lists command groups in the top-level help", () => {
    const text = renderTopHelp(registry);
    expect(text).toContain("config");
    expect(text).toContain("Manage environment variables");
    expect(text).toContain("--working-dir");
  });

  it("lists a group's commands in group help", () => {
    const text = renderGroupHelp(configGroup);
    expect(text).toContain("push");
    expect(text).toContain("Push public vars");
  });
});

describe("readPackageVersion", () => {
  it("reads the version from the nearest package.json", () => {
    const version = readPackageVersion(__dirname);
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
