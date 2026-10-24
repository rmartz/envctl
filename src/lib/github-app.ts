import { createPrivateKey, sign, type KeyObject } from "crypto";
import * as fs from "fs";

import { err, FatalError } from "./logger";
import { effectiveValue, parseManifest, type ServiceDecl } from "./manifest";

// The GitHub App credential contract (#201): a Vercel-hosted App server reads
// its Client ID (public), private key and webhook secret (both secret) from env
// vars. Like the PostHog contract, the provider owns the logical *fields* and
// the manifest's `services[].variables` map renames the env var for each.

export const GITHUB_APP_PROVIDER = "github-app";

/** The provider's logical fields. */
export type GithubAppField = "clientId" | "privateKey" | "webhookSecret";

/** Default var name for each field. */
export const DEFAULT_GITHUB_APP_VAR_NAMES: Record<GithubAppField, string> = {
  // Public: pushed by `config push`, and the JWT issuer envctl signs as.
  clientId: "GITHUB_APP_CLIENT_ID",
  privateKey: "GITHUB_APP_PRIVATE_KEY",
  webhookSecret: "GITHUB_APP_WEBHOOK_SECRET",
};

export type GithubAppVarNames = Readonly<Record<GithubAppField, string>>;

const ALL_FIELDS = Object.keys(
  DEFAULT_GITHUB_APP_VAR_NAMES,
) as GithubAppField[];

/**
 * Resolve a `github-app` service declaration into the concrete var name for
 * every field (declared override ?? default). Throws on an unknown field, an
 * empty override, or two fields mapped to the same var name.
 */
export function resolveGithubAppVars(service?: ServiceDecl): GithubAppVarNames {
  const overrides = service?.variables ?? {};
  for (const [field, name] of Object.entries(overrides)) {
    if (!ALL_FIELDS.includes(field as GithubAppField))
      throw new Error(
        `Unknown GitHub App variable field '${field}' — expected one of: ${ALL_FIELDS.join(", ")}`,
      );
    if (!name.trim())
      throw new Error(
        `GitHub App variable override for '${field}' must not be empty`,
      );
  }

  const names = {} as Record<GithubAppField, string>;
  for (const field of ALL_FIELDS)
    names[field] = overrides[field] ?? DEFAULT_GITHUB_APP_VAR_NAMES[field];

  const values = Object.values(names);
  const duplicate = values.find((name, i) => values.indexOf(name) !== i);
  if (duplicate)
    throw new Error(
      `GitHub App var names must be unique; '${duplicate}' is mapped to multiple fields`,
    );
  return names;
}

/** Everything the provider needs, resolved from the manifest and the CLI. */
export interface GithubAppConfig {
  /** Whether the manifest declares a `github-app` service at all. */
  declared: boolean;
  vars: GithubAppVarNames;
  /** The App's Client ID, from the public var in the deployment config. */
  clientId?: string;
  /** The webhook URL to point the App at (`services[].webhookUrl`). */
  webhookUrl?: string;
  /** Local path to the App's private key PEM (`--private-key-file`). */
  privateKeyFile?: string;
}

// Resolve the github-app config: var names and webhook URL from the manifest
// service, and the Client ID from the first in-scope environment whose config
// declares a literal value for it.
export function githubAppConfigFor(
  deploymentDir: string,
  privateKeyFile?: string,
): GithubAppConfig {
  const manifest = parseManifest(deploymentDir);
  const service = manifest.services.find(
    (s) => s.provider === GITHUB_APP_PROVIDER,
  );
  const vars = resolveGithubAppVars(service);
  const envs = service?.environments ?? manifest.environments;
  const clientId = envs
    .map((env) => effectiveValue(manifest, env, vars.clientId))
    .find((v) => v !== undefined && v.trim() !== "");
  return {
    declared: service !== undefined,
    vars,
    clientId,
    webhookUrl: service?.webhookUrl,
    privateKeyFile,
  };
}

/**
 * Read and validate the App private key. The key material never leaves this
 * function except as the returned values: no error message, log line or
 * exception text includes it.
 */
export function readGithubAppPrivateKey(file: string): {
  pem: string;
  key: KeyObject;
} {
  let pem: string;
  try {
    pem = fs.readFileSync(file, "utf-8").trim();
  } catch {
    return err(`GitHub App private key file not found or unreadable: ${file}`);
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    return err(`GitHub App private key file is not a valid PEM: ${file}`);
  }
  if (key.asymmetricKeyType !== "rsa")
    err(`GitHub App private key file is not an RSA private key: ${file}`);
  return { pem: `${pem}\n`, key };
}

const base64url = (input: string | Buffer): string =>
  Buffer.from(input).toString("base64url");

/**
 * An App JWT (RS256): `iss` is the Client ID, `iat` backdated 60s for clock
 * drift, and a 9-minute lifetime (GitHub's maximum is 10).
 */
export function githubAppJwt(
  clientId: string,
  key: KeyObject,
  now = Math.floor(Date.now() / 1000),
): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: clientId }),
  );
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    key,
  );
  return `${header}.${payload}.${base64url(signature)}`;
}

// Call `/app/hook/config` as the App, mapping GitHub's telling statuses to an
// actionable error (#203): a 404 means the App has no active webhook, a 401
// that the JWT was rejected.
async function githubAppHookRequest(
  jwt: string,
  method: "GET" | "PATCH",
  body?: unknown,
): Promise<void> {
  const base = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const res = await fetch(`${base}/app/hook/config`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.ok) return;
  if (res.status === 404)
    err(
      "The GitHub App's webhook is not active (GitHub returned 404 for /app/hook/config): enable it in the App's settings (check Active and set a URL), then run `envctl secrets rotate github-app`, or re-run `secrets init` if nothing was pushed yet.",
    );
  if (res.status === 401)
    err(
      "GitHub rejected the App JWT (401): check that the Client ID in the deployment config belongs to the App whose private key you passed.",
    );
  throw new FatalError(
    `GitHub API ${method} /app/hook/config failed (${res.status}): ${await res.text()}`,
  );
}

/** Assert the App's webhook config is reachable as the App (`GET /app/hook/config`). */
export function checkGithubAppHookConfig(jwt: string): Promise<void> {
  return githubAppHookRequest(jwt, "GET");
}

/** Point the App's webhook at `url`, signed with `secret` (`PATCH /app/hook/config`). */
export function patchGithubAppHookConfig(
  jwt: string,
  url: string,
  secret: string,
): Promise<void> {
  return githubAppHookRequest(jwt, "PATCH", {
    url,
    secret,
    content_type: "json",
  });
}

/**
 * Why the App private key is rotated by hand, and how. GitHub has no API to
 * create an App private key: keys are generated only on the App's settings page.
 */
export function githubAppKeyManualSteps(vars: GithubAppVarNames): string {
  const key = vars.privateKey;
  return [
    `GitHub App private keys can only be generated on the App's settings page (GitHub has no API for it), so envctl does not rotate ${key}. Rotate it by hand:`,
    `  1. GitHub → Settings → Developer settings → GitHub Apps → your App → "Generate a private key"; save the PEM locally`,
    `  2. For each Vercel target: \`vercel env rm ${key} <target>\` then \`vercel env add ${key} <target> --sensitive < new-key.pem\``,
    `  3. Redeploy and verify, then delete the old key on the App's settings page`,
  ].join("\n");
}
