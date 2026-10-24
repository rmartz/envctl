import type { DeploymentDecl, ResolvedManifest, ServiceDecl } from "./types";

// Which services reach which deployments (#215). A deployment that lists
// `services` gets exactly those; one that lists none gets every service, so a
// single-deployment manifest behaves as before.

export function servicesReaching(
  manifest: ResolvedManifest,
  deployment: DeploymentDecl,
): ServiceDecl[] {
  const listed = deployment.services;
  return listed
    ? manifest.services.filter((s) => listed.includes(s.name))
    : [...manifest.services];
}

export function deploymentsReached(
  manifest: ResolvedManifest,
  serviceName: string,
): DeploymentDecl[] {
  return manifest.deployments.filter((d) =>
    servicesReaching(manifest, d).some((s) => s.name === serviceName),
  );
}

// The services reaching `deployment` that also reach another deployment, each
// with the names of those others. Rotating one of these in a single deployment
// would invalidate a credential the others still use.
export function sharedServices(
  manifest: ResolvedManifest,
  deployment: DeploymentDecl,
): { service: ServiceDecl; with: string[] }[] {
  return servicesReaching(manifest, deployment).flatMap((service) => {
    const others = deploymentsReached(manifest, service.name)
      .map((d) => d.name)
      .filter((name) => name !== deployment.name);
    return others.length > 0 ? [{ service, with: others }] : [];
  });
}
