import { vercelTarget } from "./environments";
import { parseManifest } from "./manifest";

// Env → provider infrastructure-target resolution (#87). The manifest's
// `deployments[].targets` map is authoritative; the name convention
// (vercelTarget / TARGET_MAP) is only the fallback for an env the manifest does
// not declare — a legacy config with no `targets:` block, or an env omitted from
// the map — so existing repos resolve exactly as before.

// Build a resolver bound to one deployment dir, parsing the manifest once. Use
// this when resolving several environments (config push, the dev-source scan,
// `env list`); {@link resolveEnvTarget} is the single-env convenience.
export function envTargetResolver(
  deploymentDir: string,
): (envName: string) => string {
  const manifest = parseManifest(deploymentDir);
  const vercel = manifest.deployments.find((d) => d.provider === "vercel");
  const targets = vercel?.targets ?? {};
  return (envName) => targets[envName] ?? vercelTarget(envName);
}

// The provider target for a single environment.
export function resolveEnvTarget(
  deploymentDir: string,
  envName: string,
): string {
  return envTargetResolver(deploymentDir)(envName);
}
