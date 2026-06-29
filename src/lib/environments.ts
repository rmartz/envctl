import * as fs from "fs";
import * as path from "path";

import * as yaml from "js-yaml";

interface EnvironmentsConfig {
  active?: string[];
}

export function listActiveEnvs(deploymentDir: string): string[] {
  const envFile = path.join(deploymentDir, "environments.yml");
  const data = yaml.load(
    fs.readFileSync(envFile, "utf-8"),
  ) as EnvironmentsConfig | null;
  return data?.active ?? [];
}

export function parseDeploymentEnv(
  deploymentDir: string,
  envName: string,
): Record<string, string> {
  const envFile = path.join(deploymentDir, `${envName}.yml`);
  if (!fs.existsSync(envFile)) return {};

  const data = yaml.load(fs.readFileSync(envFile, "utf-8")) as Record<
    string,
    unknown
  > | null;
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};

  // Support nested `variables:` format ({ environment: "staging", variables: { KEY: val } })
  // as well as flat format ({ KEY: val }).
  const vars =
    data.variables !== null &&
    data.variables !== undefined &&
    typeof data.variables === "object" &&
    !Array.isArray(data.variables)
      ? (data.variables as Record<string, unknown>)
      : data;

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    )
      continue;
    const strValue =
      typeof value === "boolean" ? String(value).toLowerCase() : String(value);
    if (strValue) result[key] = strValue;
  }
  return result;
}

const TARGET_MAP: Record<string, string> = {
  production: "production",
  staging: "preview",
  preview: "preview",
  development: "development",
};

export function vercelTarget(envName: string): string {
  return TARGET_MAP[envName] ?? envName;
}
