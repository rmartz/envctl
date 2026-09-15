import * as fs from "fs";
import * as path from "path";

import {
  deploymentDir,
  environmentsFile,
  VALID_TARGETS,
} from "./commands/deployment-config";
import {
  manifestFilePath,
  parseManifest,
  type ResolvedManifest,
} from "./manifest";
import { KNOWN_DEPLOYMENT_PROVIDERS } from "./providers/registry";
import { serviceProviders } from "./providers/service";
import { envTargetResolver } from "./targets";

// A single validation result. `check` collects these across every rule and
// reports them together, so one run surfaces *all* problems rather than
// stopping at the first.
export type Severity = "error" | "warning";
export interface Finding {
  readonly severity: Severity;
  readonly message: string;
}

export const mkError = (message: string): Finding => ({
  severity: "error",
  message,
});
export const mkWarning = (message: string): Finding => ({
  severity: "warning",
  message,
});

// Static (offline) validation of a project's deployment config: it reads only
// the in-repo config, never the network. `--live` reconciliation against the
// provider lives in check-live.ts.
export function checkStatic(workingDir: string): Finding[] {
  const configDir = deploymentDir(workingDir);
  if (
    !fs.existsSync(manifestFilePath(configDir)) &&
    !fs.existsSync(environmentsFile(workingDir))
  )
    return [
      mkError(
        `No deployment config found in ${configDir} — run 'envctl init' to scaffold it.`,
      ),
    ];

  let manifest: ResolvedManifest;
  try {
    manifest = parseManifest(configDir);
  } catch (e) {
    return [
      mkError(
        `deployment/manifest.yml failed to parse: ${e instanceof Error ? e.message : String(e)}`,
      ),
    ];
  }

  const declared = new Set(manifest.environments);
  const validTargets = new Set<string>(VALID_TARGETS);
  const isVercel = (manifest.deployments[0]?.provider ?? "vercel") === "vercel";

  return [
    ...checkEnvResolution(manifest, configDir, isVercel, validTargets),
    ...checkDeploymentTargets(manifest, declared, validTargets),
    ...checkOrphanOverlays(configDir, declared),
    ...checkProvidersRegistered(manifest),
    ...checkScopes(manifest, declared),
    ...checkIdentity(workingDir, isVercel),
  ];
}

// Every declared environment must resolve to a target valid for the provider.
// Only meaningful for Vercel (the sole registered provider); an unregistered
// provider is flagged by checkProvidersRegistered instead.
function checkEnvResolution(
  manifest: ResolvedManifest,
  configDir: string,
  isVercel: boolean,
  validTargets: Set<string>,
): Finding[] {
  if (!isVercel) return [];
  const resolve = envTargetResolver(configDir);
  return manifest.environments
    .filter((env) => !validTargets.has(resolve(env)))
    .map((env) =>
      mkError(
        `environment '${env}' resolves to invalid target '${resolve(env)}' — add a deployments[].targets entry mapping it to one of: ${[...validTargets].join(", ")}.`,
      ),
    );
}

// Each deployments[].targets key must be a declared environment, and (for
// Vercel) each value must be a valid target.
function checkDeploymentTargets(
  manifest: ResolvedManifest,
  declared: Set<string>,
  validTargets: Set<string>,
): Finding[] {
  const findings: Finding[] = [];
  for (const dep of manifest.deployments) {
    for (const [env, target] of Object.entries(dep.targets)) {
      if (!declared.has(env))
        findings.push(
          mkError(
            `deployment '${dep.provider}' maps undeclared environment '${env}' — declare it under environments or remove the mapping.`,
          ),
        );
      if (dep.provider === "vercel" && !validTargets.has(target))
        findings.push(
          mkError(
            `deployment '${dep.provider}' maps '${env}' to invalid target '${target}' — valid targets: ${[...validTargets].join(", ")}.`,
          ),
        );
    }
  }
  return findings;
}

// A per-environment overlay file (deployment/<env>.yml) whose name is not a
// declared environment is an orphan: it will never be pushed and usually means
// a typo or a stale file.
function checkOrphanOverlays(
  configDir: string,
  declared: Set<string>,
): Finding[] {
  if (!fs.existsSync(configDir)) return [];
  const reserved = new Set(["manifest.yml", "environments.yml"]);
  return fs
    .readdirSync(configDir)
    .filter((f) => f.endsWith(".yml") && !reserved.has(f))
    .filter((f) => !declared.has(f.slice(0, -".yml".length)))
    .map((f) =>
      mkError(
        `overlay file '${f}' has no matching environment — declare '${f.slice(0, -".yml".length)}' or remove deployment/${f}.`,
      ),
    );
}

// Every deployment and service `provider:` must be registered.
function checkProvidersRegistered(manifest: ResolvedManifest): Finding[] {
  const findings: Finding[] = [];
  const knownDeployments = new Set(KNOWN_DEPLOYMENT_PROVIDERS);
  for (const dep of manifest.deployments)
    if (!knownDeployments.has(dep.provider))
      findings.push(
        mkError(
          `unknown deployment provider '${dep.provider}' — envctl supports: ${[...knownDeployments].join(", ")}.`,
        ),
      );

  const knownServices = new Set(serviceProviders().map((p) => p.provider));
  for (const svc of manifest.services)
    if (!knownServices.has(svc.provider))
      findings.push(
        mkError(
          `unknown service provider '${svc.provider}' — envctl supports: ${[...knownServices].join(", ")}.`,
        ),
      );
  return findings;
}

// Service and variable-group `environments:` may only reference declared
// environments.
function checkScopes(
  manifest: ResolvedManifest,
  declared: Set<string>,
): Finding[] {
  const findings: Finding[] = [];
  for (const svc of manifest.services)
    for (const env of svc.environments ?? [])
      if (!declared.has(env))
        findings.push(
          mkError(
            `service '${svc.provider}' is scoped to undeclared environment '${env}'.`,
          ),
        );
  for (const group of manifest.variableGroups)
    for (const env of group.environments ?? [])
      if (!declared.has(env))
        findings.push(
          mkError(
            `variable group '${group.name}' is scoped to undeclared environment '${env}'.`,
          ),
        );
  return findings;
}

// The Vercel deployment provider's identity should resolve. Missing identity is
// a warning, not an error: the manifest is still valid — identity is only
// needed once you push or rotate.
function checkIdentity(workingDir: string, isVercel: boolean): Finding[] {
  if (!isVercel) return [];
  const linked =
    fs.existsSync(path.join(workingDir, ".vercel", "project.json")) ||
    Boolean(process.env.VERCEL_PROJECT_ID);
  return linked
    ? []
    : [
        mkWarning(
          "Vercel project identity not resolved — .vercel/project.json is missing and VERCEL_PROJECT_ID is unset. Required for 'config push' and 'secrets', not for validation.",
        ),
      ];
}
