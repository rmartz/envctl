#!/usr/bin/env node
import { FatalError } from "./lib/logger";
import { renderGroupHelp, renderTopHelp } from "./lib/cli/help";
import { buildRegistry } from "./lib/cli/registry";
import { extractGlobalArgs, route } from "./lib/cli/router";
import { readPackageVersion } from "./lib/cli/version";

async function main(): Promise<void> {
  const registry = buildRegistry();
  const { workingDir, rest } = extractGlobalArgs(
    process.argv.slice(2),
    process.cwd(),
  );
  const result = route(rest, registry);

  switch (result.kind) {
    case "version":
      console.log(readPackageVersion(__dirname));
      return;
    case "help":
      console.log(
        result.group ? renderGroupHelp(result.group) : renderTopHelp(registry),
      );
      return;
    case "error":
      console.error(result.message);
      process.exitCode = 1;
      return;
    case "run":
      await result.command.run({ workingDir }, result.args);
      return;
  }
}

main().catch((error: unknown) => {
  if (error instanceof FatalError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
});
