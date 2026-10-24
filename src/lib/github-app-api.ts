import { sign, type KeyObject } from "crypto";

import { err, FatalError } from "./logger";

// GitHub's App API as envctl uses it (#201, #203, #206): an App JWT signed with
// the App's private key, and the `/app` and `/app/hook/config` endpoints.

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

// Call a `/app…` endpoint as the App, mapping GitHub's telling statuses to an
// actionable error (#203): a 404 on the hook config means the App has no
// active webhook, a 401 that the JWT was rejected.
async function githubAppRequest(
  jwt: string,
  method: "GET" | "PATCH",
  path: "/app" | "/app/hook/config",
  body?: unknown,
): Promise<void> {
  const base = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const res = await fetch(`${base}${path}`, {
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
  if (res.status === 404 && path === "/app/hook/config")
    err(
      "The GitHub App's webhook is not active (GitHub returned 404 for /app/hook/config): enable it in the App's settings (check Active and set a URL), then run `envctl secrets rotate github-app`, or re-run `secrets init` if nothing was pushed yet.",
    );
  if (res.status === 401)
    err(
      "GitHub rejected the App JWT (401): check that the Client ID in the deployment config belongs to the App whose private key you passed.",
    );
  throw new FatalError(
    `GitHub API ${method} ${path} failed (${res.status}): ${await res.text()}`,
  );
}

/** Assert the App's webhook config is reachable as the App (`GET /app/hook/config`). */
export function checkGithubAppHookConfig(jwt: string): Promise<void> {
  return githubAppRequest(jwt, "GET", "/app/hook/config");
}

/** Point the App's webhook at `url`, signed with `secret` (`PATCH /app/hook/config`). */
export function patchGithubAppHookConfig(
  jwt: string,
  url: string,
  secret: string,
): Promise<void> {
  return githubAppRequest(jwt, "PATCH", "/app/hook/config", {
    url,
    secret,
    content_type: "json",
  });
}

/** Prove `jwt` authenticates as the App (`GET /app`) — i.e. its key is live. */
export function checkGithubAppKey(jwt: string): Promise<void> {
  return githubAppRequest(jwt, "GET", "/app");
}
