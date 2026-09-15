import { parseManifest } from "../manifest";
import { err } from "../logger";
import {
  createVercelDeploymentProvider,
  type DeploymentProvider,
} from "./deployment";

// The deployment sinks envctl knows how to drive, keyed by the manifest
// `provider:` discriminant. Adding a hosting target is a new entry here plus its
// implementation — no edits threaded through config-push / rotation.
const DEPLOYMENT_PROVIDERS: Record<
  string,
  (workingDir: string) => DeploymentProvider
> = {
  vercel: createVercelDeploymentProvider,
};

export const KNOWN_DEPLOYMENT_PROVIDERS = Object.keys(DEPLOYMENT_PROVIDERS);

// Resolve a deployment provider by its manifest `provider:` name, erroring with
// the offending value when it is not registered.
export function resolveDeploymentProvider(
  provider: string,
  workingDir: string,
): DeploymentProvider {
  const factory = DEPLOYMENT_PROVIDERS[provider];
  if (!factory)
    return err(
      `Unknown deployment provider '${provider}' — envctl supports: ${KNOWN_DEPLOYMENT_PROVIDERS.join(", ")}`,
    );
  return factory(workingDir);
}

// The deployment provider declared by the project's manifest — the first
// `deployments[]` entry's provider, defaulting to vercel for a legacy config
// (parseManifest synthesizes a vercel deployment when none is declared).
export function resolveProjectDeployment(
  deploymentDir: string,
  workingDir: string,
): DeploymentProvider {
  const provider = parseManifest(deploymentDir).deployments[0]?.provider;
  return resolveDeploymentProvider(provider ?? "vercel", workingDir);
}
