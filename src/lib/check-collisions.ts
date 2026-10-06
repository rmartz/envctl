import { mkError, mkWarning, type Finding } from "./check";
import { effectiveValue, type ResolvedManifest } from "./manifest";
import type { DeploymentProvider } from "./providers/deployment";
import { serviceProviders, type ServiceContext } from "./providers/service";
import type { VercelEnvVar } from "./vercel-api";

// Cross-environment collisions (#175), part of `envctl check --live`: a
// service's isolated variables (`ServiceProvider.isolatedVars`, e.g. the
// Firebase project id) identify a per-environment resource, so two targets
// resolving to the same value means one environment is pointed at another's
// project — production writing to the staging project, or vice versa.

type Resolved =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "unreadable" }
  | { readonly kind: "absent" };

// The value of `key` on `target`: the live value when it can be read (plain
// values directly, encrypted ones decrypted via the provider), else the
// environment's declared literal. A sensitive (write-only) or unreadable live
// variable with no declared literal is `unreadable`.
async function resolveValue(
  deployment: DeploymentProvider,
  live: VercelEnvVar[],
  manifest: ResolvedManifest,
  env: string,
  target: string,
  key: string,
): Promise<Resolved> {
  const declared = effectiveValue(manifest, env, key);
  const fallback: Resolved | undefined =
    declared !== undefined ? { kind: "value", value: declared } : undefined;
  const found = live.find((e) => e.key === key && e.target.includes(target));
  if (!found) return fallback ?? { kind: "absent" };
  if (found.type === "plain" && found.value)
    return { kind: "value", value: found.value };
  if (found.type !== "sensitive") {
    try {
      return { kind: "value", value: await deployment.getEnvVarValue(found.id) };
    } catch {
      // fall through to the declared literal
    }
  }
  return fallback ?? { kind: "unreadable" };
}

export async function checkCollisions(
  manifest: ResolvedManifest,
  ctx: ServiceContext,
  live: VercelEnvVar[],
  resolveTarget: (env: string) => string,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const providers = new Map(serviceProviders().map((p) => [p.provider, p]));

  for (const svc of manifest.services) {
    const keys = providers.get(svc.provider)?.isolatedVars?.(ctx) ?? [];
    const envs = svc.environments ?? manifest.environments;
    for (const key of keys) {
      // One value per distinct target; envs sharing a target trivially agree.
      const byValue = new Map<string, string[]>();
      const seenTargets = new Set<string>();
      for (const env of envs) {
        const target = resolveTarget(env);
        if (seenTargets.has(target)) continue;
        seenTargets.add(target);
        const resolved = await resolveValue(
          ctx.deployment,
          live,
          manifest,
          env,
          target,
          key,
        );
        if (resolved.kind === "unreadable")
          findings.push(
            mkWarning(
              `'${key}' on the '${target}' target is sensitive or unreadable and has no declared value — skipped the cross-environment collision check for it.`,
              { kind: "collision-skipped", env, target, key },
            ),
          );
        if (resolved.kind !== "value") continue;
        byValue.set(resolved.value, [
          ...(byValue.get(resolved.value) ?? []),
          `${env} (${target})`,
        ]);
      }
      for (const [value, where] of byValue)
        if (where.length > 1)
          findings.push(
            mkError(
              `'${key}' resolves to the same value '${value}' in ${where.join(" and ")} — ${svc.provider} requires a distinct value per environment, so one environment is pointed at another's resource.`,
              { kind: "collision", key },
            ),
          );
    }
  }
  return findings;
}
