import * as fs from "fs";
import * as path from "path";

import { parse } from "yaml";

import {
  listActiveEnvs,
  parseDeploymentEnv,
  vercelTarget,
} from "../environments";
import type {
  DeploymentDecl,
  ResolvedManifest,
  ServiceDecl,
  VariableDecl,
  VariableGroup,
  VariableSource,
} from "./types";

export const MANIFEST_FILENAME = "manifest.yml";

export function manifestFilePath(deploymentDir: string): string {
  return path.join(deploymentDir, MANIFEST_FILENAME);
}

// ─── Field parsers (each tolerates malformed input by ignoring it) ──────────

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseVariableSource(spec: unknown): VariableSource | undefined {
  if (!isRecord(spec)) return undefined;
  const { value, generate } = spec;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return { kind: "value", value: String(value) };
  if (generate === true) return { kind: "generate" };
  return undefined;
}

function parseVariables(raw: unknown): VariableDecl[] {
  if (!isRecord(raw)) return [];
  const out: VariableDecl[] = [];
  for (const [name, spec] of Object.entries(raw)) {
    const source = parseVariableSource(spec);
    if (source) out.push({ name, source });
  }
  return out;
}

function parseStringMap(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function parseServices(raw: unknown): ServiceDecl[] {
  if (!Array.isArray(raw)) return [];
  const out: ServiceDecl[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.provider !== "string") continue;
    const service: {
      provider: string;
      environments?: string[];
      credential?: "split" | "json";
      variables?: Record<string, string>;
    } = { provider: item.provider };
    if ("environments" in item)
      service.environments = asStringArray(item.environments);
    if (item.credential === "split" || item.credential === "json")
      service.credential = item.credential;
    if ("variables" in item) service.variables = parseStringMap(item.variables);
    out.push(service);
  }
  return out;
}

function parseDeployments(raw: unknown): DeploymentDecl[] {
  if (!Array.isArray(raw)) return [];
  const out: DeploymentDecl[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.provider !== "string") continue;
    const targets: Record<string, string> = {};
    if (isRecord(item.targets)) {
      for (const [env, target] of Object.entries(item.targets)) {
        if (typeof target === "string") targets[env] = target;
      }
    }
    out.push({ provider: item.provider, targets });
  }
  return out;
}

function parseVariableGroups(raw: unknown): VariableGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: VariableGroup[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.name !== "string") continue;
    const variables = parseVariables(item.variables);
    out.push(
      "environments" in item
        ? {
            name: item.name,
            environments: asStringArray(item.environments),
            variables,
          }
        : { name: item.name, variables },
    );
  }
  return out;
}

// Per-environment overlay files hold only literal `value` overrides. They share
// the legacy per-env file format (flat or nested `variables:`), so they parse
// through the existing reader.
function readOverlays(
  deploymentDir: string,
  environments: readonly string[],
): Record<string, Record<string, string>> {
  const base = path.resolve(deploymentDir);
  const overlays: Record<string, Record<string, string>> = {};
  for (const env of environments) {
    if (path.dirname(path.resolve(deploymentDir, `${env}.yml`)) !== base) {
      continue;
    }
    const values = parseDeploymentEnv(deploymentDir, env);
    if (Object.keys(values).length > 0) overlays[env] = values;
  }
  return overlays;
}

// ─── Entry point ───────────────────────────────────────────────────────────

/**
 * Parse a project's deployment configuration into the resolved model. Reads
 * `deployment/manifest.yml` when present; otherwise falls back to the legacy
 * flat format (`environments.yml` + per-env value files) mapped onto the same
 * model, so existing projects parse unchanged.
 */
export function parseManifest(deploymentDir: string): ResolvedManifest {
  const file = manifestFilePath(deploymentDir);
  return fs.existsSync(file)
    ? parseManifestFile(deploymentDir, file)
    : parseLegacy(deploymentDir);
}

interface RawManifest {
  environments?: unknown;
  deployments?: unknown;
  services?: unknown;
  variables?: unknown;
  variableGroups?: unknown;
}

function parseManifestFile(
  deploymentDir: string,
  file: string,
): ResolvedManifest {
  const content = fs.readFileSync(file, "utf-8");
  const parsed: unknown = content.trim() === "" ? {} : parse(content);
  const raw = (isRecord(parsed) ? parsed : {}) as RawManifest;
  // When the manifest has no `environments` key (e.g. created by `env add
  // --target` which writes only a `deployments` block), fall back to
  // environments.yml so the hybrid state returns the correct env list.
  const environments =
    raw.environments !== undefined
      ? asStringArray(raw.environments)
      : fs.existsSync(path.join(deploymentDir, "environments.yml"))
        ? listActiveEnvs(deploymentDir)
        : [];
  return {
    environments,
    deployments: parseDeployments(raw.deployments),
    services: parseServices(raw.services),
    variables: parseVariables(raw.variables),
    variableGroups: parseVariableGroups(raw.variableGroups),
    overlays: readOverlays(deploymentDir, environments),
  };
}

// Back-compat: no manifest.yml. Map the legacy `environments.yml` (active list)
// and flat per-env value files onto the model — each env name defaulted through
// vercelTarget() under a single implicit vercel deployment, and every per-env
// var treated as a literal `value` overlay. Legacy config has no place to
// declare services, top-level variables, or groups, so those stay empty.
function parseLegacy(deploymentDir: string): ResolvedManifest {
  // listActiveEnvs reads environments.yml directly (it does not guard the file's
  // existence), so a project with no config at all degrades to an empty model.
  const environments = fs.existsSync(
    path.join(deploymentDir, "environments.yml"),
  )
    ? listActiveEnvs(deploymentDir)
    : [];
  const targets: Record<string, string> = {};
  for (const env of environments) targets[env] = vercelTarget(env);
  return {
    environments,
    deployments:
      environments.length > 0 ? [{ provider: "vercel", targets }] : [],
    services: [],
    variables: [],
    variableGroups: [],
    overlays: readOverlays(deploymentDir, environments),
  };
}
