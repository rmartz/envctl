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

  async updateEnvVar(envId: string, value: string): Promise<void> {
    await this.request(`/v9/projects/${this.projectId}/env/${envId}`, "PATCH", {
      value,
    });
  }

  async deleteEnvVar(envId: string): Promise<void> {
    await this.request(`/v9/projects/${this.projectId}/env/${envId}`, "DELETE");
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

  async pollDeploymentStatus(
    deploymentId: string,
    maxAttempts = 60,
    intervalMs = 10_000,
  ): Promise<void> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = await this.request<{ status: string }>(
        `/v13/deployments/${deploymentId}`,
      );
      if (result.status === "READY") return;
      if (result.status === "ERROR" || result.status === "CANCELED") {
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
