import { err } from "../logger";
import { servicesReaching } from "./routing";
import type { DeploymentDecl, ResolvedManifest } from "./types";
import {
  isSafeDeploymentName,
  viewEnvironments,
  type DeploymentView,
} from "./view";

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
  for (const { name } of manifest.deployments)
    if (!isSafeDeploymentName(name))
      errors.push(
        `deployment name '${name}' must be a plain name (letters, digits, '.', '_', '-') — it names the <deployment-dir>/${name} view.`,
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
    // The rotation engine keys services by provider, so a second instance of
    // a provider reaching the same deployment would be silently ignored (#215).
    const reaching = servicesReaching(manifest, dep);
    for (const provider of duplicates(reaching.map((s) => s.provider)))
      errors.push(
        `deployment '${dep.name}' receives more than one ${provider} service (${reaching
          .filter((s) => s.provider === provider)
          .map((s) => s.name)
          .join(", ")}) — list only one in its services.`,
      );
  }
  return errors;
}

// The one deployment a command acts on. A multi-deployment manifest is
// refused rather than silently acting on its first entry, which could send one
// project's secrets to another; a command selects one through its view
// (`--deployment <name>`, #213).
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
  return `The manifest declares ${deployments.length} deployments (${deployments.map((d) => d.name).join(", ")}); select one with --deployment <name>.`;
}

// A deployment view's resolved model (#213): the root manifest narrowed to one
// deployment. Only the services it lists reach it, so a command run against
// one deployment can never act on another's service. Its own variables win
// over same-named top-level ones. An invalid root is refused, since a dangling
// reference would otherwise silently drop a service from the view.
export function projectView(
  root: ResolvedManifest,
  view: DeploymentView,
  overlays: ResolvedManifest["overlays"],
): ResolvedManifest {
  const { deployment } = view;
  const errors = manifestErrors(root);
  if (errors.length > 0)
    return err(
      `Can't resolve deployment '${deployment.name}': the manifest in ${view.root} is invalid:\n  ${errors.join("\n  ")}`,
    );
  const listed = deployment.services;
  const own = deployment.variables ?? [];
  const ownNames = new Set(own.map((v) => v.name));
  return {
    environments: viewEnvironments(view),
    deployments: [deployment],
    services: listed
      ? root.services.filter((s) => listed.includes(s.name))
      : root.services,
    variables: [...root.variables.filter((v) => !ownNames.has(v.name)), ...own],
    variableGroups: root.variableGroups,
    overlays,
    ...(root.github ? { github: root.github } : {}),
  };
}
