import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from "crypto";
import * as fs from "fs";

import { err } from "./logger";
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

/**
 * The key's SHA-256 fingerprint as GitHub shows it on the App's settings page:
 * `SHA256:` + base64 of the SHA-256 of the public key's DER (SPKI) encoding.
 * Public information: it identifies the key without revealing it.
 */
export function githubAppKeyFingerprint(key: KeyObject): string {
  const der = createPublicKey(key).export({ type: "spki", format: "der" });
  return `SHA256:${createHash("sha256").update(der).digest("base64")}`;
}
