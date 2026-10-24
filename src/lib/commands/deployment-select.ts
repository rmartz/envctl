import * as fs from "fs";
import * as path from "path";

import { err } from "../logger";
import {
  deploymentView,
  isSafeDeploymentName,
  parseManifest,
} from "../manifest";

// Usage lines shared by every command that takes the deployment flags.
export const DEPLOYMENT_FLAGS_USAGE = `  --deployment-dir <path>  Path to the deployment config directory, resolved
                           against the project root (default: deployment)
  --deployment <name>      Act on the named deployment of that directory's
                           manifest (its view, <deployment-dir>/<name>)`;

function hasOwnConfig(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "manifest.yml")) ||
    fs.existsSync(path.join(dir, "environments.yml"))
  );
}

// The absolute config dir a command acts on (#213): `--deployment-dir`
// (default `deployment`) against the project root, narrowed by `--deployment
// <name>` to that manifest's deployment view, `<dir>/<name>`. An unknown name
// errors with the declared ones, so a typo can't fall through to another
// project's config.
export function resolveDeploymentDir(
  workingDir: string,
  dirArg: string,
  name: string | undefined,
): string {
  const base = path.resolve(workingDir, dirArg);
  if (name === undefined) return base;
  if (!isSafeDeploymentName(name))
    return err(`Invalid --deployment '${name}': use a plain deployment name.`);
  const dir = path.join(base, name);
  if (deploymentView(dir) || hasOwnConfig(dir)) return dir;
  const declared = parseManifest(base).deployments.map((d) => d.name);
  return err(
    `No deployment named '${name}' in ${base}. Declared: ${declared.length > 0 ? declared.join(", ") : "none"}.`,
  );
}
