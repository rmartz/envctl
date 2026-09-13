import type { ResolvedManifest, VariableDecl } from "./types";

// Find a variable's declaration visible in an environment: a top-level
// (all-env) variable, else a group variable whose group is scoped to the env.
function findDeclaration(
  manifest: ResolvedManifest,
  env: string,
  name: string,
): VariableDecl | undefined {
  const top = manifest.variables.find((v) => v.name === name);
  if (top) return top;
  for (const group of manifest.variableGroups) {
    if (group.environments && !group.environments.includes(env)) continue;
    const found = group.variables.find((v) => v.name === name);
    if (found) return found;
  }
  return undefined;
}

/**
 * The effective literal value of a variable in an environment: a per-env
 * overlay override wins over the declared base `value`. Returns `undefined`
 * when the variable has no literal value there — unknown, or a non-literal
 * source (`generate`/service) that carries no value in git.
 */
export function effectiveValue(
  manifest: ResolvedManifest,
  env: string,
  name: string,
): string | undefined {
  const overlay = manifest.overlays[env]?.[name];
  if (overlay !== undefined) return overlay;
  const decl = findDeclaration(manifest, env, name);
  return decl?.source.kind === "value" ? decl.source.value : undefined;
}
