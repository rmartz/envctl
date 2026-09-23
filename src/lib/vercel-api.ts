import { FatalError } from "./logger";

export interface VercelEnvVar {
  id: string;
  key: string;
  value: string;
  target: string[];
  type: "plain" | "encrypted" | "secret";
  createdAt?: number;
  updatedAt?: number;
}

export interface VercelEnvVarList {
  envs: VercelEnvVar[];
  pagination?: { next?: number };
}

export interface VercelDeployment {
  uid: string;
  url: string;
  name: string;
  readyState?: string;
  status?: string;
}

export class VercelClient {
  private baseUrl = "https://api.vercel.com";

  constructor(
    private token: string,
    private projectId: string,
    private teamId?: string,
  ) {}

  private buildUrl(path: string): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (this.teamId) url.searchParams.set("teamId", this.teamId);
    return url.toString();
  }

  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const url = this.buildUrl(path);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new FatalError(
        `Vercel API ${method} ${path} failed (${res.status}): ${text}`,
      );
    }
    if (res.status === 204 || method === "DELETE") return undefined as T;
    return res.json() as Promise<T>;
  }

  async listEnvVars(): Promise<VercelEnvVarList> {
    let result = await this.request<VercelEnvVarList>(
      `/v9/projects/${this.projectId}/env?limit=100`,
    );
    while (result.pagination?.next) {
      const page = await this.request<VercelEnvVarList>(
        `/v9/projects/${this.projectId}/env?limit=100&since=${result.pagination.next}`,
      );
      result = {
        envs: [...result.envs, ...page.envs],
        pagination: page.pagination,
      };
    }
    return result;
  }

  async getEnvVarValue(envId: string): Promise<string> {
    const record = await this.request<{ value: string }>(
      `/v1/projects/${this.projectId}/env/${envId}`,
    );
    return record.value;
  }

  async createEnvVar(
    key: string,
    value: string,
    target: string,
    type: "plain" | "encrypted" = "plain",
  ): Promise<VercelEnvVar> {
    return this.request<VercelEnvVar>(
      `/v10/projects/${this.projectId}/env`,
      "POST",
      {
        key,
        value,
        target: [target],
        type,
      },
    );
  }

  // Edit an existing env var in place. Vercel's PATCH silently ignores a
  // value-only body (leaving the var stale — #124); the reliable edit request
  // carries the record's full descriptor, so we resend key/type/target from the
  // existing record alongside the new value. Preserving `target` also keeps a
  // multi-target record's other environments intact.
  async updateEnvVar(existing: VercelEnvVar, value: string): Promise<void> {
    await this.request(
      `/v9/projects/${this.projectId}/env/${existing.id}`,
      "PATCH",
      {
        key: existing.key,
        type: existing.type,
        target: existing.target,
        value,
      },
    );
  }

  async deleteEnvVar(envId: string): Promise<void> {
    await this.request(`/v9/projects/${this.projectId}/env/${envId}`, "DELETE");
  }

  /**
   * Remove one Vercel target from an env-var record. If the record covers only
   * that target, the record is deleted outright; otherwise it is patched to
   * remove just that target so the credential is preserved for the remaining
   * environments.
   */
  async removeEnvVarFromTarget(
    envId: string,
    existingTargets: string[],
    vercelEnv: string,
  ): Promise<void> {
    const remaining = existingTargets.filter((t) => t !== vercelEnv);
    if (remaining.length === 0) {
      await this.deleteEnvVar(envId);
    } else {
      await this.request(
        `/v9/projects/${this.projectId}/env/${envId}`,
        "PATCH",
        { target: remaining },
      );
    }
  }

  findEnvVar(
    envs: VercelEnvVar[],
    key: string,
    target: string,
  ): VercelEnvVar | undefined {
    return envs.find((e) => e.key === key && e.target.includes(target));
  }

  async setEnvForTarget(
    key: string,
    value: string,
    target: string,
    allEnvs: VercelEnvVar[],
    type: "plain" | "encrypted" = "encrypted",
  ): Promise<string> {
    const existing = this.findEnvVar(allEnvs, key, target);
    if (existing) {
      await this.deleteEnvVar(existing.id);
    }
    const created = await this.createEnvVar(key, value, target, type);
    if (!created.id) {
      const refetched = await this.listEnvVars();
      const confirmed = this.findEnvVar(refetched.envs, key, target);
      if (!confirmed?.id) {
        throw new Error(
          `Failed to confirm ${key} was saved for ${target} after write`,
        );
      }
      return confirmed.id;
    }
    return created.id;
  }

  async getLatestDeployment(
    target: "production" | "staging",
  ): Promise<VercelDeployment | null> {
    const url = new URL(`${this.baseUrl}/v6/deployments`);
    url.searchParams.set("projectId", this.projectId);
    url.searchParams.set("target", target);
    url.searchParams.set("limit", "1");
    url.searchParams.set("state", "READY");
    if (this.teamId) url.searchParams.set("teamId", this.teamId);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) return null;
    const text = await res.text();
    // eslint-disable-next-line no-control-regex
    const cleaned = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
    const data = JSON.parse(cleaned) as { deployments: VercelDeployment[] };
    return data.deployments[0] ?? null;
  }

  async triggerRedeployment(
    deploymentId: string,
    name: string,
    target?: string,
  ): Promise<string> {
    const body: Record<string, string> = { deploymentId, name };
    if (target !== undefined) body.target = target;
    const result = await this.request<{ id: string }>(
      "/v13/deployments",
      "POST",
      body,
    );
    return result.id;
  }

  async listPreviewDeployments(): Promise<VercelDeployment[]> {
    const url = new URL(`${this.baseUrl}/v6/deployments`);
    url.searchParams.set("projectId", this.projectId);
    url.searchParams.set("state", "READY");
    url.searchParams.set("limit", "50");
    if (this.teamId) url.searchParams.set("teamId", this.teamId);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      deployments: (VercelDeployment & { target: string | null })[];
    };
    // PR preview deployments have target === null; production and aliased
    // preview (staging) deployments have an explicit target string.
    return data.deployments.filter((d) => d.target === null);
  }

  // Poll until the deployment reaches a terminal state. `READY` → "ready";
  // `CANCELED` → "canceled" (a benign auto-cancel — Vercel supersedes a redeploy
  // with a newer build, or the project auto-cancels redundant ones — so the
  // caller warns rather than fails, #125). Only a genuine `ERROR` (or a timeout)
  // throws.
  async pollDeploymentStatus(
    deploymentId: string,
    maxAttempts = 60,
    intervalMs = 10_000,
  ): Promise<"ready" | "canceled"> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = await this.request<{ status: string }>(
        `/v13/deployments/${deploymentId}`,
      );
      if (result.status === "READY") return "ready";
      if (result.status === "CANCELED") return "canceled";
      if (result.status === "ERROR") {
        throw new Error(
          `Deployment ${deploymentId} ended with status: ${result.status}`,
        );
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(
      `Deployment ${deploymentId} timed out after ${maxAttempts} attempts`,
    );
  }
}
