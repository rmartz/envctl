import { resolveFirebaseCredential } from "./firebase-credential";
import { GITHUB_APP_PROVIDER, resolveGithubAppVars } from "./github-app";
import {
  servicesReaching,
  type ResolvedManifest,
  type ServiceDecl,
} from "./manifest";
import { resolvePosthogVars } from "./posthog";
import { serviceProviders, type ServiceVarContext } from "./providers/service";

// Variable names a manifest's services resolve to, without a live deployment
// (#215). The engine keys services by provider, so the first service of each
// provider names that provider's variables.
export function serviceVarContext(
  services: readonly ServiceDecl[],
): ServiceVarContext {
  const of = (provider: string): ServiceDecl | undefined =>
    services.find((s) => s.provider === provider);
  return {
    firebaseCredential: resolveFirebaseCredential(of("firebase")),
    posthogVars: resolvePosthogVars(of("posthog")),
    githubApp: {
      declared: of(GITHUB_APP_PROVIDER) !== undefined,
      vars: resolveGithubAppVars(of(GITHUB_APP_PROVIDER)),
    },
  };
}

// Every variable one declared service owns: its contract variables plus the
// keys that signal it is provisioned. An unregistered provider owns none.
export function serviceVarNames(service: ServiceDecl): string[] {
  const provider = serviceProviders().find(
    (p) => p.provider === service.provider,
  );
  if (!provider) return [];
  const ctx = serviceVarContext([service]);
  return [
    ...new Set([
      ...(provider.contractVars?.(ctx) ?? []),
      ...provider.presenceKeys(ctx),
    ]),
  ];
}

// Two services of different providers reaching one deployment must not write
// the same variable: the later rotation would silently overwrite the earlier
// service's credential. (Two of one provider are already a manifestErrors
// error, since the engine keys services by provider.)
export function serviceVarCollisions(manifest: ResolvedManifest): string[] {
  return manifest.deployments.flatMap((deployment) => {
    const owner = new Map<string, ServiceDecl>();
    const messages: string[] = [];
    for (const service of servicesReaching(manifest, deployment))
      for (const name of serviceVarNames(service)) {
        const first = owner.get(name);
        if (first === undefined) owner.set(name, service);
        else if (first.provider !== service.provider)
          messages.push(
            `deployment '${deployment.name}': services '${first.name}' and '${service.name}' both write ${name} — rename one through its 'variables' map.`,
          );
      }
    return messages;
  });
}
