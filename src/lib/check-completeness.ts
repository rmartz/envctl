import * as fs from "fs";

import { mkError, mkWarning, type Finding } from "./check";
import { resolveFirebaseCredential } from "./firebase-credential";
import { manifestFilePath, type ResolvedManifest } from "./manifest";
import { resolvePosthogVars } from "./posthog";
import type { DeploymentProvider } from "./providers/deployment";
import {
  serviceProviders,
  type ServiceContext,
  type ServiceProvider,
} from "./providers/service";
import type { VercelEnvVar } from "./vercel-api";

// Required-variable completeness (#175), part of `envctl check --live`: every
// target must carry every variable the project declares for it, and nothing
// the project does not. A target that silently lacks a credential still builds
// READY and ships a broken app, so a missing variable is an error; a leftover
// one is a warning (it is read by nothing, but may still hold a live secret).

// The variables one environment declares. `required` must be present on its
// target; `known` (a superset) are tolerated there without being orphans — e.g.
// a service's legacy alias that rotation still reads.
export interface EnvDeclaration {
  readonly env: string;
  readonly target: string;
  readonly required: ReadonlySet<string>;
  readonly known: ReadonlySet<string>;
}

// Variables the deployment provider manages itself (Vercel system variables),
// never declared by a project and never orphans.
const PROVIDER_MANAGED = /^(NEXT_PUBLIC_)?VERCEL(_|$)/;

// The ServiceContext `check` hands providers: only the contract inputs are
// meaningful here (no run, so no scratch dir or target selection).
export function checkServiceContext(
  manifest: ResolvedManifest,
  deployment: DeploymentProvider,
): ServiceContext {
  return {
    targetEnv: "all",
    deployment,
    tempDir: "",
    firebaseCredential: resolveFirebaseCredential(
      manifest.services.find((s) => s.provider === "firebase"),
    ),
    posthogVars: resolvePosthogVars(
      manifest.services.find((s) => s.provider === "posthog"),
    ),
  };
}

const serviceRequired = (p: ServiceProvider, ctx: ServiceContext): string[] =>
  p.contractVars?.(ctx) ?? p.presenceKeys(ctx);
const serviceKnown = (p: ServiceProvider, ctx: ServiceContext): string[] => [
  ...serviceRequired(p, ctx),
  ...p.presenceKeys(ctx),
];

// Resolve each environment's declared variables: manifest top-level variables,
// variable groups scoped to it (generated secrets included), its overlay keys,
// and the contract variables of every service scoped to it. A legacy config
// (no manifest.yml) cannot declare services, so every registered service's
// variables are tolerated there but not required.
export function declaredByEnv(
  configDir: string,
  manifest: ResolvedManifest,
  ctx: ServiceContext,
  resolveTarget: (env: string) => string,
): EnvDeclaration[] {
  const legacy = !fs.existsSync(manifestFilePath(configDir));
  const providers = new Map(serviceProviders().map((p) => [p.provider, p]));
  const legacyKnown = legacy
    ? [...providers.values()].flatMap((p) => serviceKnown(p, ctx))
    : [];

  return manifest.environments.map((env) => {
    const required = new Set<string>([
      ...manifest.variables.map((v) => v.name),
      ...manifest.variableGroups
        .filter((g) => !g.environments || g.environments.includes(env))
        .flatMap((g) => g.variables.map((v) => v.name)),
      ...Object.keys(manifest.overlays[env] ?? {}),
    ]);
    const known = new Set<string>([...required, ...legacyKnown]);
    for (const svc of manifest.services) {
      if (svc.environments && !svc.environments.includes(env)) continue;
      const provider = providers.get(svc.provider);
      if (!provider) continue; // unregistered — flagged by checkStatic
      for (const key of serviceRequired(provider, ctx)) required.add(key);
      for (const key of serviceKnown(provider, ctx)) known.add(key);
    }
    return { env, target: resolveTarget(env), required, known };
  });
}

// Compare the declared sets against the live variables: a declared variable
// absent from its target is **missing** (error); a live variable on a checked
// target that no environment mapping to it declares is **orphaned** (warning).
export function checkCompleteness(
  declarations: EnvDeclaration[],
  live: VercelEnvVar[],
): Finding[] {
  const findings: Finding[] = [];
  const reported = new Set<string>();

  for (const { env, target, required } of declarations)
    for (const key of required) {
      const present = live.some(
        (e) => e.key === key && e.target.includes(target),
      );
      if (present || reported.has(`${target}|${key}`)) continue;
      reported.add(`${target}|${key}`);
      findings.push(
        mkError(
          `'${key}' is declared for '${env}' but missing on the '${target}' target — the app will run without it. Provision it with 'envctl config push' (public values) or 'envctl secrets' (service credentials, generated secrets).`,
          { kind: "missing", env, target, key },
        ),
      );
    }

  const knownByTarget = new Map<string, Set<string>>();
  for (const { target, known } of declarations) {
    const set = knownByTarget.get(target) ?? new Set<string>();
    for (const key of known) set.add(key);
    knownByTarget.set(target, set);
  }

  for (const [target, known] of knownByTarget)
    for (const e of live) {
      if (!e.target.includes(target) || known.has(e.key)) continue;
      if (PROVIDER_MANAGED.test(e.key)) continue;
      findings.push(
        mkWarning(
          `'${e.key}' is present on the '${target}' target but declared nowhere (orphaned) — delete it, and if it holds a credential, invalidate that credential at its source.`,
          { kind: "orphaned", target, key: e.key },
        ),
      );
    }
  return findings;
}
