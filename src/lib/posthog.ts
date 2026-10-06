import { parseDeploymentEnv } from "./environments";
import { err } from "./logger";
import { parseManifest, type ServiceDecl } from "./manifest";
import { envTargetResolver } from "./targets";

// The PostHog variable contract (#173). Like the Firebase credential contract,
// the provider owns the logical *fields* and the manifest's
// `services[].variables` map can rename the env var each field is written to.

/** The provider's logical fields. */
export type PosthogField = "projectKey" | "host" | "personalApiKey";

/** Default var name for each field — what a Next.js app reads out of the box. */
export const DEFAULT_POSTHOG_VAR_NAMES: Record<PosthogField, string> = {
  // Public project API key (`phc_…`); must differ per environment.
  projectKey: "NEXT_PUBLIC_POSTHOG_KEY",
  // Public ingestion host, or the app's own `/ingest` reverse-proxy path.
  host: "NEXT_PUBLIC_POSTHOG_HOST",
  // Optional secret: server-side flag local evaluation / query API.
  personalApiKey: "POSTHOG_PERSONAL_API_KEY",
};

export type PosthogVarNames = Readonly<Record<PosthogField, string>>;

const ALL_FIELDS = Object.keys(DEFAULT_POSTHOG_VAR_NAMES) as PosthogField[];

/**
 * Resolve a `posthog` service declaration into the concrete var name for every
 * field (declared override ?? default). Throws on an unknown field, an empty
 * override, or two fields mapped to the same var name.
 */
export function resolvePosthogVars(service?: ServiceDecl): PosthogVarNames {
  const overrides = service?.variables ?? {};
  for (const [field, name] of Object.entries(overrides)) {
    if (!ALL_FIELDS.includes(field as PosthogField))
      throw new Error(
        `Unknown PostHog variable field '${field}' — expected one of: ${ALL_FIELDS.join(", ")}`,
      );
    if (!name.trim())
      throw new Error(
        `PostHog variable override for '${field}' must not be empty`,
      );
  }

  const names = {} as Record<PosthogField, string>;
  for (const field of ALL_FIELDS)
    names[field] = overrides[field] ?? DEFAULT_POSTHOG_VAR_NAMES[field];

  const values = Object.values(names);
  const duplicate = values.find((name, i) => values.indexOf(name) !== i);
  if (duplicate)
    throw new Error(
      `PostHog var names must be unique; '${duplicate}' is mapped to multiple fields`,
    );
  return names;
}

/** The PostHog var names declared by the deployment dir's manifest. */
export function posthogVarsFor(deploymentDir: string): PosthogVarNames {
  return resolvePosthogVars(
    parseManifest(deploymentDir).services.find((s) => s.provider === "posthog"),
  );
}

/**
 * Why PostHog's personal API key is rotated by hand, and how. PostHog's API
 * refuses to create, roll, list, or delete personal API keys when the request is
 * itself authenticated with a personal API key — those actions need a logged-in
 * browser session — so envctl cannot mint a replacement.
 */
export function posthogManualSteps(names: PosthogVarNames): string {
  const key = names.personalApiKey;
  return [
    `PostHog personal API keys cannot be created, rolled, or deleted through the PostHog API (it only allows that from a logged-in browser session), so envctl does not rotate ${key}. Rotate it by hand:`,
    `  1. PostHog → Settings → Personal API keys → create a new key with the same scopes (avoid "Roll", which kills the old value before the new one is deployed)`,
    `  2. For each Vercel target: \`vercel env rm ${key} <target>\` then \`vercel env add ${key} <target> --sensitive\``,
    `  3. Redeploy, verify, then delete the old key in PostHog`,
    `The public ${names.projectKey} / ${names.host} values belong in deployment/{env}.yml — push them with \`envctl config push\`.`,
  ].join("\n");
}

/**
 * Per-environment isolation guard (#173), the analytics counterpart of the
 * Firebase cross-project guard (#126): refuse when two environments that deploy
 * to different targets resolve to the same PostHog project key, so staging
 * traffic can never land in the production project. Checks every active env —
 * not just the ones being pushed — because a single-env push can still collide
 * with a value already live on another target. Errors before anything is written.
 */
export function assertPosthogProjectIsolation(
  deploymentDir: string,
  envNames: string[],
): void {
  const keyVar = posthogVarsFor(deploymentDir).projectKey;
  const resolveTarget = envTargetResolver(deploymentDir);
  const seen = new Map<string, { env: string; target: string }>();
  const collisions: string[] = [];

  for (const env of envNames) {
    const value = parseDeploymentEnv(deploymentDir, env)[keyVar];
    if (!value) continue;
    const target = resolveTarget(env);
    const prior = seen.get(value);
    if (!prior) seen.set(value, { env, target });
    else if (prior.target !== target)
      collisions.push(
        `'${prior.env}' (${prior.target}) and '${env}' (${target})`,
      );
  }

  if (collisions.length > 0)
    err(
      `Refusing to push: ${keyVar} is identical across environments ${collisions.join(", ")}. ` +
        `Each environment must use its own PostHog project so non-production traffic never lands in production — ` +
        `create a separate PostHog project and set its key in the deployment YAML.`,
    );
}
