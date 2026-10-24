import * as path from "path";

import { vercelTarget } from "../environments";
import { GITHUB_APP_PROVIDER } from "../github-app";
import { err } from "../logger";
import {
  deploymentsReached,
  deploymentView,
  parseManifest,
  sharedServices,
  type DeploymentDecl,
  type ResolvedManifest,
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
// deployment that lists it; a service several deployments share selects all
// of them (#216): the first is the run's primary, the rest `sharedDirs`.
export function selectService(
  baseDir: string,
  deploymentDir: string,
  deploymentChosen: boolean,
  target: string,
): {
  deploymentDir: string;
  provider: ProviderKeyword;
  sharedDirs?: string[];
} {
  const root = parseManifest(baseDir);
  if (!deploymentChosen && root.deployments.length > 1) {
    const service =
      findService(root.services, target) ??
      err(`No service '${target}' is declared in ${baseDir}/manifest.yml.`);
    const reached = deploymentsReached(root, service.name);
    const [first, ...rest] = reached.map((d) => path.join(baseDir, d.name));
    if (first === undefined)
      return err(`No deployment lists service '${service.name}'.`);
    const provider = providerOf(service);
    if (rest.length === 0) return { deploymentDir: first, provider };
    assertShareable(root, service, reached);
    return { deploymentDir: first, provider, sharedDirs: rest };
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

// A shared-service run writes one credential to every project, so they must
// agree on where it goes: the same provider targets for the same environments.
// A GitHub App can't be shared at all — it has one webhook URL.
function assertShareable(
  root: ResolvedManifest,
  service: ServiceDecl,
  deployments: readonly DeploymentDecl[],
): void {
  if (service.provider === GITHUB_APP_PROVIDER)
    err(
      `Service '${service.name}' is a GitHub App listed by several deployments (${deployments.map((d) => d.name).join(", ")}); an App has one webhook URL, so give each deployment its own App.`,
    );
  const targetsOf = (d: DeploymentDecl): string =>
    JSON.stringify(
      [...(d.environments ?? root.environments)]
        .sort()
        .map((env) => [env, d.targets[env] ?? vercelTarget(env)]),
    );
  const [first, ...rest] = deployments;
  if (first && rest.some((d) => targetsOf(d) !== targetsOf(first)))
    err(
      `Deployments sharing service '${service.name}' (${deployments.map((d) => d.name).join(", ")}) map their environments to different targets; a shared credential needs them to match. Run it per deployment with --deployment instead.`,
    );
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
      )}. Rotate it across every deployment instead (name the service, run on the root without --deployment), rotate with --no-invalidate, or scope the rotation to an unshared service.`,
  );
}
