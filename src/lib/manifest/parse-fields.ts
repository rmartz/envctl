import type {
  DeploymentDecl,
  GithubDecl,
  GithubSecretDecl,
  ServiceDecl,
  VariableDecl,
  VariableGroup,
  VariableSource,
} from "./types";

// Field parsers for manifest.yml entries. Each tolerates malformed input by
// ignoring it, so a hand-edited manifest degrades rather than throwing; `check`
// reports what was meant but dropped.

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
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

export function parseVariables(raw: unknown): VariableDecl[] {
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

// A non-empty string `name`, else the fallback (#211).
function nameOr(item: Record<string, unknown>, fallback: string): string {
  return typeof item.name === "string" && item.name ? item.name : fallback;
}

export function parseServices(raw: unknown): ServiceDecl[] {
  if (!Array.isArray(raw)) return [];
  const out: ServiceDecl[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.provider !== "string") continue;
    const service: {
      name: string;
      provider: string;
      environments?: string[];
      variables?: Record<string, string>;
      webhookUrl?: string;
    } = { name: nameOr(item, item.provider), provider: item.provider };
    if ("environments" in item)
      service.environments = asStringArray(item.environments);
    if ("variables" in item) service.variables = parseStringMap(item.variables);
    if (typeof item.webhookUrl === "string")
      service.webhookUrl = item.webhookUrl;
    out.push(service);
  }
  return out;
}

export function parseDeployments(raw: unknown): DeploymentDecl[] {
  if (!Array.isArray(raw)) return [];
  const out: DeploymentDecl[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.provider !== "string") continue;
    const { projectId, teamId } = item;
    out.push({
      name: nameOr(item, item.provider),
      provider: item.provider,
      targets: parseStringMap(item.targets),
      ...(typeof projectId === "string" && projectId ? { projectId } : {}),
      ...(typeof teamId === "string" && teamId ? { teamId } : {}),
      ...("services" in item ? { services: asStringArray(item.services) } : {}),
      ...("environments" in item
        ? { environments: asStringArray(item.environments) }
        : {}),
      ...("variables" in item
        ? { variables: parseVariables(item.variables) }
        : {}),
    });
  }
  return out;
}

export function parseVariableGroups(raw: unknown): VariableGroup[] {
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

// An entry without both `variable` and `environment` has nothing to mirror, so
// it is dropped like any other malformed item.
export function parseGithub(raw: unknown): GithubDecl | undefined {
  if (!isRecord(raw)) return undefined;
  const secrets: GithubSecretDecl[] = [];
  for (const item of Array.isArray(raw.secrets) ? raw.secrets : []) {
    if (!isRecord(item)) continue;
    const { variable, environment, name, githubEnvironment, deployment } = item;
    if (typeof variable !== "string" || typeof environment !== "string")
      continue;
    secrets.push({
      variable,
      environment,
      ...(typeof name === "string" ? { name } : {}),
      ...(typeof githubEnvironment === "string" ? { githubEnvironment } : {}),
      ...(typeof deployment === "string" ? { deployment } : {}),
    });
  }
  return typeof raw.repo === "string"
    ? { repo: raw.repo, secrets }
    : { secrets };
}
