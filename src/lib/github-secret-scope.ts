import * as path from "path";

import {
  parseManifest,
  type DeploymentDecl,
  type ResolvedManifest,
} from "./manifest";
import { serviceVarNames } from "./service-vars";

// GitHub secret mirroring across deployments (#217). Each deployment's run
// mirrors the variables it pushes, so an unscoped mirror whose variable two
// deployments push would be overwritten by whichever ran last.

// The variables a deployment's runs write: its literal and generated
// variables, its overlay keys, and its services' variables.
function pushedBy(configDir: string, deployment: DeploymentDecl): Set<string> {
  const view = parseManifest(path.join(configDir, deployment.name));
  return new Set([
    ...view.variables.map((v) => v.name),
    ...view.variableGroups.flatMap((g) => g.variables.map((v) => v.name)),
    ...Object.values(view.overlays).flatMap((o) => Object.keys(o)),
    ...view.services.flatMap(serviceVarNames),
  ]);
}

// Messages for each GitHub secret without a `deployment` whose variable more
// than one deployment of a multi-deployment root pushes. Call only on a root
// whose manifestErrors are empty, since it resolves every deployment's view.
export function githubSecretAmbiguities(
  configDir: string,
  root: ResolvedManifest,
): string[] {
  if (root.deployments.length <= 1) return [];
  const pushed = root.deployments.map(
    (d) => [d.name, pushedBy(configDir, d)] as const,
  );
  return (root.github?.secrets ?? [])
    .filter((s) => s.deployment === undefined)
    .flatMap((s) => {
      const by = pushed
        .filter(([, names]) => names.has(s.variable))
        .map(([name]) => name);
      return by.length > 1
        ? [
            `GitHub secret ${s.name ?? s.variable} mirrors ${s.variable}, which deployments ${by.join(", ")} all push — set its 'deployment' so one doesn't overwrite another's value.`,
          ]
        : [];
    });
}
