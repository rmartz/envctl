import { mkError, type Finding } from "./check";
import {
  servicesReaching,
  type DeploymentDecl,
  type ResolvedManifest,
} from "./manifest";
import { serviceVarNames } from "./service-vars";
import type { VercelEnvVar } from "./vercel-api";

// Service-variable ownership on a live project (#215). The static collision
// rule is serviceVarCollisions, in service-vars.ts.

// A deployment's project must not hold a variable owned only by a service the
// deployment doesn't list — e.g. another App's private key, left over from
// before the deployments were split. `declared` is every variable the
// deployment itself declares, which a foreign service's name may coincide with.
export function checkForeignServiceVars(
  root: ResolvedManifest,
  deployment: DeploymentDecl,
  declared: ReadonlySet<string>,
  live: readonly VercelEnvVar[],
): Finding[] {
  const reaching = servicesReaching(root, deployment);
  const own = new Set([...declared, ...reaching.flatMap(serviceVarNames)]);
  const foreign = new Map<string, string>();
  for (const service of root.services)
    if (!reaching.includes(service))
      for (const name of serviceVarNames(service))
        if (!own.has(name)) foreign.set(name, service.name);
  const keys = new Set(live.map((v) => v.key));
  return [...foreign]
    .filter(([name]) => keys.has(name))
    .map(([name, service]) =>
      mkError(
        `deployment '${deployment.name}' holds ${name}, which belongs to service '${service}' that it doesn't list — remove it from the project.`,
        { kind: "foreign", key: name },
      ),
    );
}
