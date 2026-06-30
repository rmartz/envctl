// The command registry — the single extension point for the CLI surface.
// Later milestones add their groups here (config, env, secrets, auth) without
// touching the router or entrypoint.

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

// The live registry. Empty until command groups land in their own sub-issues;
// the router and help output are driven entirely by whatever is listed here.
export function buildRegistry(): Registry {
  return [];
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
