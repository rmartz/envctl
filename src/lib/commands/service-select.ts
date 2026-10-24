import * as path from "path";

import { err } from "../logger";
import {
  deploymentsReached,
  deploymentView,
  parseManifest,
  sharedServices,
  type ServiceDecl,
} from "../manifest";

// Secrets commands name a service: a provider keyword, as before, or a
// manifest service name such as `gate-app` (#215).
export const PROVIDER_KEYWORDS = [
  "firebase",
  "sentry",
  "posthog",
  "github-app",
] as const;
export type ProviderKeyword = (typeof PROVIDER_KEYWORDS)[number];

function isProviderKeyword(value: string): value is ProviderKeyword {
  return (PROVIDER_KEYWORDS as readonly string[]).includes(value);
}

// The service a name selects: one named so, else the only one of that
// provider. Several of one provider must be named explicitly.
function findService(
  services: readonly ServiceDecl[],
  target: string,
): ServiceDecl | undefined {
  const named = services.find((s) => s.name === target);
  if (named) return named;
  const ofProvider = services.filter((s) => s.provider === target);
  if (ofProvider.length > 1)
    return err(
      `Several ${target} services are declared (${ofProvider.map((s) => s.name).join(", ")}) — name the one to act on.`,
    );
  return ofProvider[0];
}

function providerOf(service: ServiceDecl): ProviderKeyword {
  if (isProviderKeyword(service.provider)) return service.provider;
  return err(
    `Service '${service.name}' uses provider '${service.provider}', which secrets commands don't manage.`,
  );
}

// Resolve a secrets command's positional service against the manifest: the
// deployment dir to act on and the provider to drive. Run on the root of a
// multi-deployment manifest without --deployment, the service picks the
// deployment, if only one lists it. Acting on a service several deployments
// share is refused until shared rotation lands (#216).
export function selectService(
  baseDir: string,
  deploymentDir: string,
  deploymentChosen: boolean,
  target: string,
): { deploymentDir: string; provider: ProviderKeyword } {
  const root = parseManifest(baseDir);
  if (!deploymentChosen && root.deployments.length > 1) {
    const service =
      findService(root.services, target) ??
      err(`No service '${target}' is declared in ${baseDir}/manifest.yml.`);
    const reached = deploymentsReached(root, service.name);
    if (reached.length !== 1)
      return err(
        reached.length === 0
          ? `No deployment lists service '${service.name}'.`
          : `Service '${service.name}' is shared by deployments ${reached.map((d) => d.name).join(", ")}; select one with --deployment <name>. Acting on all of them at once is not supported yet (#216).`,
      );
    return {
      deploymentDir: path.join(baseDir, reached[0]?.name ?? ""),
      provider: providerOf(service),
    };
  }
  if (isProviderKeyword(target)) return { deploymentDir, provider: target };
  const services = parseManifest(deploymentDir).services;
  const service =
    services.find((s) => s.name === target) ??
    err(
      `No service '${target}' reaches this deployment (services: ${services.map((s) => s.name).join(", ") || "none"}).`,
    );
  return { deploymentDir, provider: providerOf(service) };
}

// Refuses a rotation that would invalidate a credential another deployment
// still uses (#215): a service this deployment shares, rotated with
// invalidation. `provider` scopes the check to one provider; unscoped, any
// shared service blocks it.
export function assertNoSharedRotation(
  deploymentDir: string,
  provider: string | undefined,
): void {
  const view = deploymentView(deploymentDir);
  if (!view) return;
  const shared = sharedServices(
    parseManifest(view.root),
    view.deployment,
  ).filter((s) => provider === undefined || s.service.provider === provider);
  if (shared.length === 0) return;
  err(
    `Rotating in deployment '${view.deployment.name}' would invalidate a credential other deployments still use: ${shared
      .map((s) => `'${s.service.name}' (shared with ${s.with.join(", ")})`)
      .join(
        "; ",
      )}. Rotate with --no-invalidate, scope the rotation to an unshared service, or wait for shared rotation (#216).`,
  );
}
