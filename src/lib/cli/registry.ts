// The command registry — the single extension point for the CLI surface.
// Later milestones add their groups here (config, env, secrets, auth) without
// touching the router or entrypoint.

import { runAuthStatus } from "../commands/auth";
import { configPushCommand } from "../commands/config-push";
import { runEnvAdd, runEnvList } from "../commands/env";
import { runInit } from "../commands/init";

export interface CommandContext {
  // The project root commands operate on, resolved from -C/--working-dir or CWD.
  workingDir: string;
}

export interface Command {
  name: string;
  summary: string;
  run(ctx: CommandContext, args: string[]): void | Promise<void>;
}

export interface CommandGroup {
  name: string;
  summary: string;
  commands: Command[];
  // A directly-runnable "leaf" group: `envctl <name>` with no subcommand runs
  // this (e.g. `init`). Container groups (config, env) leave it undefined and
  // require a subcommand instead.
  run?: Command["run"];
}

export type Registry = CommandGroup[];

// The live registry. The router and help output are driven entirely by whatever
// is listed here; later milestones add their groups (env, secrets, auth).
export function buildRegistry(): Registry {
  return [
    {
      name: "config",
      summary: "Manage environment variables",
      commands: [
        {
          name: "push",
          summary: "Push public (non-secret) env vars to the provider",
          run: configPushCommand,
        },
      ],
    },
    {
      name: "env",
      summary: "Define project environments and their target mappings",
      commands: [
        {
          name: "add",
          summary: "Add an environment and its target mapping",
          run: runEnvAdd,
        },
        {
          name: "list",
          summary: "List defined environments and their provider targets",
          run: runEnvList,
        },
      ],
    },
    {
      name: "init",
      summary: "Scaffold the deployment/ config in this project",
      commands: [],
      run: runInit,
    },
    {
      name: "auth",
      summary: "Inspect provider credentials",
      commands: [
        {
          name: "status",
          summary: "Show which providers are authenticated and how",
          run: runAuthStatus,
        },
      ],
    },
  ];
}

export function findGroup(
  registry: Registry,
  name: string,
): CommandGroup | undefined {
  return registry.find((g) => g.name === name);
}

export function findCommand(
  group: CommandGroup,
  name: string,
): Command | undefined {
  return group.commands.find((c) => c.name === name);
}
