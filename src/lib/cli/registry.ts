// The command registry — the single extension point for the CLI surface.
// Later milestones add their groups here (config, env, secrets, auth) without
// touching the router or entrypoint.

import { configPushCommand } from "../commands/config-push";

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
