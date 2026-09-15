import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  generateSecretValue,
  pushGeneratedSecrets,
  resolveGeneratedSecrets,
  type GeneratedSecret,
} from "../lib/generated-secrets";
import type { DeploymentProvider } from "../lib/providers/deployment";
import type { VercelEnvVar } from "../lib/vercel-api";

// Minimal in-memory DeploymentProvider — only the methods pushGeneratedSecrets
// exercises (listEnvVars / findEnvVar / setEnvForTarget) against a live store.
class FakeDeployment {
  private seq = 0;
  envs: VercelEnvVar[] = [];
  listEnvVars(): Promise<{ envs: VercelEnvVar[]; pagination: undefined }> {
    return Promise.resolve({
      envs: this.envs.map((e) => ({ ...e })),
      pagination: undefined,
    });
  }
  findEnvVar(
    envs: VercelEnvVar[],
    key: string,
    target: string,
  ): VercelEnvVar | undefined {
    return envs.find((e) => e.key === key && e.target.includes(target));
  }
  setEnvForTarget(key: string, value: string, target: string): Promise<string> {
    this.envs = this.envs.filter(
      (e) => !(e.key === key && e.target.includes(target)),
    );
    const id = `id-${++this.seq}`;
    this.envs.push({ id, key, value, target: [target], type: "encrypted" });
    return Promise.resolve(id);
  }
}

const asDeployment = (fake: FakeDeployment): DeploymentProvider =>
  fake as unknown as DeploymentProvider;

const valueFor = (
  fake: FakeDeployment,
  key: string,
  target: string,
): string | undefined =>
  fake.envs.find((e) => e.key === key && e.target.includes(target))?.value;

describe("generateSecretValue", () => {
  it("returns a base64url-encoded 32-byte value (AC3)", () => {
    const value = generateSecretValue();
    expect(value).toMatch(/^[A-Za-z0-9_-]+$/); // base64url alphabet, no padding
    expect(Buffer.from(value, "base64url")).toHaveLength(32);
  });

  it("returns a distinct value each call", () => {
    expect(generateSecretValue()).not.toBe(generateSecretValue());
  });
});

describe("resolveGeneratedSecrets", () => {
  let deployDir: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-secret-test-"));
    deployDir = path.join(tmpDir, "deployment");
    fs.mkdirSync(deployDir);
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const write = (name: string, content: string): void =>
    fs.writeFileSync(path.join(deployDir, name), content);

  it("maps a top-level generate var to every environment's target", () => {
    write(
      "manifest.yml",
      [
        "environments: [production, staging]",
        "variables:",
        "  CRON_SECRET: { generate: true }",
        '  NEXT_PUBLIC_SITE_NAME: { value: "x" }',
      ].join("\n") + "\n",
    );
    expect(resolveGeneratedSecrets(deployDir)).toEqual([
      { name: "CRON_SECRET", targets: ["production", "preview"] },
    ]);
  });

  it("scopes a grouped generate var to its group's environments (AC7)", () => {
    write(
      "manifest.yml",
      [
        "environments: [production, staging]",
        "variableGroups:",
        "  - name: prod-analytics",
        "    environments: [production]",
        "    variables:",
        "      ANALYTICS_WRITE_KEY: { generate: true }",
      ].join("\n") + "\n",
    );
    expect(resolveGeneratedSecrets(deployDir)).toEqual([
      { name: "ANALYTICS_WRITE_KEY", targets: ["production"] },
    ]);
  });

  it("returns nothing for a legacy config with no manifest", () => {
    write("environments.yml", "active:\n  - production\n");
    expect(resolveGeneratedSecrets(deployDir)).toEqual([]);
  });
});

describe("pushGeneratedSecrets", () => {
  const cron = (): GeneratedSecret[] => [
    { name: "CRON_SECRET", targets: ["production", "preview"] },
  ];

  it("mints a distinct value per target (AC1, AC2)", async () => {
    const fake = new FakeDeployment();
    await pushGeneratedSecrets(asDeployment(fake), cron(), {
      overwrite: false,
      targetEnv: "all",
    });
    const prod = valueFor(fake, "CRON_SECRET", "production");
    const preview = valueFor(fake, "CRON_SECRET", "preview");
    expect(prod).toBeTruthy();
    expect(preview).toBeTruthy();
    expect(prod).not.toBe(preview);
  });

  it("is idempotent on init — leaves an existing value untouched (AC4)", async () => {
    const fake = new FakeDeployment();
    fake.envs.push({
      id: "e1",
      key: "CRON_SECRET",
      value: "already-set",
      target: ["production"],
      type: "encrypted",
    });
    const wrote = await pushGeneratedSecrets(asDeployment(fake), cron(), {
      overwrite: false,
      targetEnv: "all",
    });
    expect(valueFor(fake, "CRON_SECRET", "production")).toBe("already-set");
    expect(valueFor(fake, "CRON_SECRET", "preview")).toBeTruthy();
    expect(wrote).toBe(true); // preview was minted
  });

  it("re-mints every scoped value on rotate (AC5)", async () => {
    const fake = new FakeDeployment();
    fake.envs.push({
      id: "e1",
      key: "CRON_SECRET",
      value: "old-prod",
      target: ["production"],
      type: "encrypted",
    });
    await pushGeneratedSecrets(asDeployment(fake), cron(), {
      overwrite: true,
      targetEnv: "all",
    });
    expect(valueFor(fake, "CRON_SECRET", "production")).not.toBe("old-prod");
  });

  it("only writes the requested target when scoped to one env", async () => {
    const fake = new FakeDeployment();
    await pushGeneratedSecrets(asDeployment(fake), cron(), {
      overwrite: false,
      targetEnv: "production",
    });
    expect(valueFor(fake, "CRON_SECRET", "production")).toBeTruthy();
    expect(valueFor(fake, "CRON_SECRET", "preview")).toBeUndefined();
  });

  it("never pushes a secret to a target outside its scope (AC7)", async () => {
    const fake = new FakeDeployment();
    await pushGeneratedSecrets(
      asDeployment(fake),
      [{ name: "ANALYTICS_WRITE_KEY", targets: ["production"] }],
      { overwrite: false, targetEnv: "all" },
    );
    expect(valueFor(fake, "ANALYTICS_WRITE_KEY", "preview")).toBeUndefined();
    expect(valueFor(fake, "ANALYTICS_WRITE_KEY", "production")).toBeTruthy();
  });
});
