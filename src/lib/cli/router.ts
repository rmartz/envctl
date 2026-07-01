import * as path from "path";

import { err } from "../logger";
import type { Command, CommandGroup, Registry } from "./registry";
import { findCommand, findGroup } from "./registry";

const HELP_FLAGS = new Set(["-h", "--help"]);

export interface GlobalArgs {
  // Resolved (absolute) project root the dispatched command operates on.
  workingDir: string;
  // argv with the global -C/--working-dir flag (and its value) removed.
  rest: string[];
}

// Pulls the global -C/--working-dir flag out of argv wherever it appears,
// resolving its value against `cwd`. Defaults to `cwd` when absent. Throws a
// FatalError (via err) when the flag is given without a directory value.
export function extractGlobalArgs(argv: string[], cwd: string): GlobalArgs {
  let workingDir = cwd;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-C" || arg === "--working-dir") {
      const value = argv[i + 1];
      if (value === undefined) {
        err(`${arg} requires a directory argument`);
      }
      workingDir = path.resolve(cwd, value);
      i++; // consume the value
      continue;
    }
    rest.push(arg);
  }

  return { workingDir, rest };
}

export type RouteResult =
  | { kind: "version" }
  | { kind: "help"; group?: CommandGroup }
  | { kind: "run"; group: CommandGroup; command: Command; args: string[] }
  | { kind: "error"; message: string };

// Pure routing over the non-global tokens. Returns a description of what the
// entrypoint should do; performs no IO so it is fully unit-testable.
export function route(tokens: string[], registry: Registry): RouteResult {
  const [first, second, ...rest] = tokens;

  if (first === undefined || HELP_FLAGS.has(first)) {
    return { kind: "help" };
  }
  if (first === "--version") {
    return { kind: "version" };
  }

  const group = findGroup(registry, first);
  if (!group) {
    return { kind: "error", message: `unknown command: ${first}` };
  }

  // A runnable leaf group (e.g. `init`) with no subcommand runs directly.
  if (second === undefined && group.run) {
    return {
      kind: "run",
      group,
      command: { name: group.name, summary: group.summary, run: group.run },
      args: [],
    };
  }

  if (second === undefined || HELP_FLAGS.has(second)) {
    return { kind: "help", group };
  }

  const command = findCommand(group, second);
  if (!command) {
    return {
      kind: "error",
      message: `unknown command: ${group.name} ${second}`,
    };
  }

  return { kind: "run", group, command, args: rest };
}
