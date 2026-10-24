import { err } from "../logger";
import type { DeploymentDecl, ResolvedManifest } from "./types";

// Named deployments and services (#211): the structural rules a manifest must
// satisfy before any command can route services and variables to deployments.

function duplicates(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) dupes.add(name);
    seen.add(name);
  }
  return [...dupes];
}

// Every structural problem with the manifest's deployments and services, as
// human-readable messages. Pure: `check` reports them, and commands can refuse
// on them, without either re-deriving the rules.
export function manifestErrors(manifest: ResolvedManifest): string[] {
  const errors: string[] = [];
  for (const name of duplicates(manifest.services.map((s) => s.name)))
    errors.push(
      `service name '${name}' is declared more than once — give each instance a distinct 'name'.`,
    );
  for (const name of duplicates(manifest.deployments.map((d) => d.name)))
    errors.push(
      `deployment name '${name}' is declared more than once — give each a distinct 'name'.`,
    );
  const services = new Set(manifest.services.map((s) => s.name));
  const environments = new Set(manifest.environments);
  for (const dep of manifest.deployments) {
    for (const ref of dep.services ?? [])
      if (!services.has(ref))
        errors.push(
          `deployment '${dep.name}' references undefined service '${ref}'.`,
        );
    for (const env of dep.environments ?? [])
      if (!environments.has(env))
        errors.push(
          `deployment '${dep.name}' is scoped to undeclared environment '${env}'.`,
        );
  }
  return errors;
}

// The one deployment a command acts on. Selecting among several lands with
// #210's CLI selection; until then a multi-deployment manifest is refused
// rather than silently acting on its first entry, which could send one
// project's secrets to another.
export function soleDeployment(
  manifest: ResolvedManifest,
): DeploymentDecl | undefined {
  const tooMany = multipleDeploymentsError(manifest);
  if (tooMany) return err(tooMany);
  return manifest.deployments[0];
}

// Why `soleDeployment` would refuse this manifest, or undefined if it wouldn't.
export function multipleDeploymentsError(
  manifest: ResolvedManifest,
): string | undefined {
  const { deployments } = manifest;
  if (deployments.length <= 1) return undefined;
  return `The manifest declares ${deployments.length} deployments (${deployments.map((d) => d.name).join(", ")}); this envctl version acts on one deployment per manifest. Split them into separate --deployment-dir directories for now.`;
}
