import { describe, expect, it, vi } from "vitest";

import type { CommandGroup, Registry } from "../lib/cli/registry";
import { renderGroupHelp } from "../lib/cli/help";
import { route } from "../lib/cli/router";

const run = vi.fn();

// A directly-runnable "leaf" group (the shape `init` uses).
const initGroup: CommandGroup = {
  name: "init",
  summary: "Scaffold the deployment/ config",
  commands: [],
  run,
};
const registry: Registry = [initGroup];

describe("route — runnable leaf group", () => {
  it("runs a leaf group invoked with no subcommand", () => {
    expect(route(["init"], registry)).toEqual({
      kind: "run",
      group: initGroup,
      command: { name: "init", summary: initGroup.summary, run },
      args: [],
    });
  });

  it("shows group help for a leaf group with --help", () => {
    expect(route(["init", "--help"], registry)).toEqual({
      kind: "help",
      group: initGroup,
    });
  });
});

describe("renderGroupHelp — leaf group", () => {
  it("uses a bare usage line (no <command>) for a runnable leaf group", () => {
    const text = renderGroupHelp(initGroup);
    expect(text).toContain("envctl init");
    expect(text).not.toContain("envctl init <command>");
  });
});
