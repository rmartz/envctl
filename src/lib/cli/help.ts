import type { CommandGroup, Registry } from "./registry";

// Renders the top-level help: usage plus the list of command groups. With an
// empty registry the groups section is omitted, so the output stays coherent
// until command groups land.
export function renderTopHelp(registry: Registry): string {
  const lines = [
    "envctl — manage deploy configuration and provider secrets across projects",
    "",
    "Usage:",
    "  envctl [-C <dir>] <group> <command> [args]",
    "  envctl --version",
    "  envctl --help",
    "",
    "Global flags:",
    "  -C, --working-dir <dir>   Project root to operate on (default: current directory)",
    "  -h, --help                Show help",
    "      --version             Print the envctl version",
  ];

  if (registry.length > 0) {
    lines.push("", "Command groups:");
    const width = Math.max(...registry.map((g) => g.name.length));
    for (const group of registry) {
      lines.push(`  ${group.name.padEnd(width)}   ${group.summary}`);
    }
    lines.push("", "Run 'envctl <group> --help' for a group's commands.");
  }

  return lines.join("\n");
}

// Renders help for a single group: its commands and their summaries.
export function renderGroupHelp(group: CommandGroup): string {
  const lines = [
    `envctl ${group.name} — ${group.summary}`,
    "",
    "Usage:",
    `  envctl ${group.name} <command> [args]`,
  ];

  if (group.commands.length > 0) {
    lines.push("", "Commands:");
    const width = Math.max(...group.commands.map((c) => c.name.length));
    for (const command of group.commands) {
      lines.push(`  ${command.name.padEnd(width)}   ${command.summary}`);
    }
  }

  return lines.join("\n");
}
