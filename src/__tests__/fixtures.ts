import * as fs from "fs";
import * as path from "path";

import type { VercelClient, VercelEnvVar } from "../lib/vercel-api";

export const MINTED = {
  private_key_id: "new-key-id",
  private_key: "-----BEGIN PRIVATE KEY-----\nnew\n-----END PRIVATE KEY-----\n",
  client_email: "sa@proj.iam.gserviceaccount.com",
  project_id: "proj-x",
};

export class FakeVercel {
  private seq = 0;
  envs: VercelEnvVar[];
  constructor(envs: VercelEnvVar[] = []) {
    this.envs = envs;
  }
  listEnvVars(): Promise<{ envs: VercelEnvVar[]; pagination: undefined }> {
    return Promise.resolve({
      envs: this.envs.map((e) => ({ ...e })),
      pagination: undefined,
    });
  }
  getEnvVarValue(id: string): Promise<string> {
    const e = this.envs.find((x) => x.id === id);
    return e
      ? Promise.resolve(e.value)
      : Promise.reject(new Error(`no var ${id}`));
  }
  findEnvVar(
    envs: VercelEnvVar[],
    key: string,
    target: string,
  ): VercelEnvVar | undefined {
    return envs.find((e) => e.key === key && e.target.includes(target));
  }
  deleteEnvVar(id: string): Promise<void> {
    this.envs = this.envs.filter((e) => e.id !== id);
    return Promise.resolve();
  }
  removeEnvVarFromTarget(
    id: string,
    existingTargets: string[],
    vercelEnv: string,
  ): Promise<void> {
    const remaining = existingTargets.filter((t) => t !== vercelEnv);
    if (remaining.length === 0) {
      this.envs = this.envs.filter((e) => e.id !== id);
    } else {
      this.envs = this.envs.map((e) =>
        e.id === id ? { ...e, target: remaining } : e,
      );
    }
    return Promise.resolve();
  }
  setEnvForTarget(
    key: string,
    value: string,
    target: string,
    _all: VercelEnvVar[],
    type: "plain" | "encrypted" = "encrypted",
  ): Promise<string> {
    this.envs = this.envs.filter(
      (e) => !(e.key === key && e.target.includes(target)),
    );
    const id = `id-${++this.seq}`;
    this.envs.push({ id, key, value, target: [target], type });
    return Promise.resolve(id);
  }
}

export const asClient = (fake: FakeVercel): VercelClient =>
  fake as unknown as VercelClient;

export const valueFor = (
  fake: FakeVercel,
  key: string,
  target: string,
): string | undefined =>
  fake.envs.find((e) => e.key === key && e.target.includes(target))?.value;

export const envVar = (
  id: string,
  key: string,
  value: string,
): VercelEnvVar => ({
  id,
  key,
  value,
  target: ["production"],
  type: "encrypted",
});

export function makeDeploymentDir(
  tmpDir: string,
  active: string[],
  envVars: Record<string, Record<string, string>>,
): string {
  const deployDir = path.join(tmpDir, "deployment");
  fs.mkdirSync(deployDir);
  fs.writeFileSync(
    path.join(deployDir, "environments.yml"),
    `active:\n${active.map((e) => `  - ${e}`).join("\n")}\n`,
  );
  for (const [envName, vars] of Object.entries(envVars)) {
    const lines = Object.entries(vars)
      .map(([k, v]) => `${k}: "${v}"`)
      .join("\n");
    fs.writeFileSync(path.join(deployDir, `${envName}.yml`), lines + "\n");
  }
  return deployDir;
}
