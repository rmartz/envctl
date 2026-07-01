import * as fs from "fs";

import type { CommandContext } from "../cli/registry";
import { log, warn } from "../logger";
import {
  deploymentDir,
  envFile,
  environmentsFile,
  writeActiveEnvs,
  writeEnvFile,
} from "./deployment-config";

// `envctl init` — scaffold the in-repo deployment/ config with a starter
// environments.yml and a sample environment file. No-op (with a warning) when
// a config already exists, so it never clobbers hand-edited config.
export function runInit(ctx: CommandContext): void {
  const envsFile = environmentsFile(ctx.workingDir);
  if (fs.existsSync(envsFile)) {
    warn(`Deployment config already exists at ${envsFile} — leaving it as is.`);
    return;
  }

  fs.mkdirSync(deploymentDir(ctx.workingDir), { recursive: true });
  writeActiveEnvs(ctx.workingDir, ["production"]);
  if (!fs.existsSync(envFile(ctx.workingDir, "production"))) {
    writeEnvFile(ctx.workingDir, "production", {
      NEXT_PUBLIC_EXAMPLE: "replace-me",
    });
  }

  log(`Scaffolded ${envsFile} with a sample 'production' environment.`);
  log(
    "Add more with: envctl env add <name> --target <production|preview|development>",
  );
}
