import { resolveVercelToken } from "../auth";
import {
  refreshPreviewDeployments as refreshPreviews,
  triggerAndWaitRedeployments as triggerRedeploy,
} from "../deployments";
import { FatalError } from "../logger";
import { detectProject } from "../project";
import {
  VercelClient,
  type VercelEnvVar,
  type VercelEnvVarList,
} from "../vercel-api";

type EnvVarType = "plain" | "encrypted";

// A hosting sink — the manifest `deployments[].provider`. Captures project
// identity, per-target env-var reads/writes, and redeploy orchestration, so
// `config push` and the secrets engine work against this interface rather than
// referencing Vercel by name. Vercel is the only implementation today; a new
// sink (netlify, cloudflare, …) is a new implementation registered by name.
export interface DeploymentProvider {
  readonly provider: string;
  readonly projectId: string;
  readonly teamId: string | undefined;
  listEnvVars(): Promise<VercelEnvVarList>;
  getEnvVarValue(id: string): Promise<string>;
  findEnvVar(
    envs: VercelEnvVar[],
    key: string,
    target: string,
  ): VercelEnvVar | undefined;
  createEnvVar(
    key: string,
    value: string,
    target: string,
    type?: EnvVarType,
  ): Promise<VercelEnvVar>;
  updateEnvVar(existing: VercelEnvVar, value: string): Promise<void>;
  setEnvForTarget(
    key: string,
    value: string,
    target: string,
    envs: VercelEnvVar[],
    type?: EnvVarType,
  ): Promise<string>;
  removeEnvVarFromTarget(
    id: string,
    existingTargets: string[],
    vercelEnv: string,
  ): Promise<void>;
  triggerAndWaitRedeployments(targetEnv: string): Promise<void>;
  refreshPreviewDeployments(): Promise<void>;
}

// The Vercel deployment provider — wraps VercelClient + deployments.ts, with
// identity resolved from VERCEL_* env vars / .vercel/project.json. Delegation
// keeps VercelClient's behavior (and its prototype, which the tests spy on)
// unchanged.
class VercelDeploymentProvider implements DeploymentProvider {
  readonly provider = "vercel";
  readonly projectId: string;
  readonly teamId: string | undefined;
  private readonly client: VercelClient;

  constructor(workingDir: string) {
    const token = resolveVercelToken();
    if (!token)
      throw new FatalError(
        "No Vercel token found. Set VERCEL_TOKEN or run 'vercel login' to authenticate.",
      );
    const project = detectProject(workingDir);
    this.projectId = project.projectId;
    this.teamId = project.teamId;
    this.client = new VercelClient(token, project.projectId, project.teamId);
  }

  listEnvVars(): Promise<VercelEnvVarList> {
    return this.client.listEnvVars();
  }
  getEnvVarValue(id: string): Promise<string> {
    return this.client.getEnvVarValue(id);
  }
  findEnvVar(
    envs: VercelEnvVar[],
    key: string,
    target: string,
  ): VercelEnvVar | undefined {
    return this.client.findEnvVar(envs, key, target);
  }
  createEnvVar(
    key: string,
    value: string,
    target: string,
    type: EnvVarType = "plain",
  ): Promise<VercelEnvVar> {
    return this.client.createEnvVar(key, value, target, type);
  }
  updateEnvVar(existing: VercelEnvVar, value: string): Promise<void> {
    return this.client.updateEnvVar(existing, value);
  }
  setEnvForTarget(
    key: string,
    value: string,
    target: string,
    envs: VercelEnvVar[],
    type?: EnvVarType,
  ): Promise<string> {
    // Forward `type` only when the caller set it, so the underlying client's
    // own default applies and the delegated call keeps its original arity.
    return type === undefined
      ? this.client.setEnvForTarget(key, value, target, envs)
      : this.client.setEnvForTarget(key, value, target, envs, type);
  }
  removeEnvVarFromTarget(
    id: string,
    existingTargets: string[],
    vercelEnv: string,
  ): Promise<void> {
    return this.client.removeEnvVarFromTarget(id, existingTargets, vercelEnv);
  }
  triggerAndWaitRedeployments(targetEnv: string): Promise<void> {
    return triggerRedeploy(targetEnv, this.client);
  }
  refreshPreviewDeployments(): Promise<void> {
    return refreshPreviews(this.client);
  }
}

export function createVercelDeploymentProvider(
  workingDir: string,
): DeploymentProvider {
  return new VercelDeploymentProvider(workingDir);
}
