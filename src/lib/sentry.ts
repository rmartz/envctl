import { err, log, warn } from "./logger";
import { VercelClient } from "./vercel-api";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SentryKey {
  id: string;
  dsn: { public: string };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function targetEnvs(targetEnv: string): string[] {
  if (targetEnv === "all") return ["production", "preview", "development"];
  return [targetEnv];
}

async function sentryRequest<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const token = process.env.SENTRY_AUTH_TOKEN;
  if (!token) err("SENTRY_AUTH_TOKEN is required for Sentry key rotation");

  const base = process.env.SENTRY_URL ?? "https://sentry.io";
  const res = await fetch(`${base}/api/0${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Sentry API ${method} ${path} failed (${res.status}): ${text}`,
    );
  }
  if (method === "DELETE") return undefined as T;
  return res.json() as Promise<T>;
}

// ─── Sentry rotation ──────────────────────────────────────────────────────────

export async function rotateSentry(
  targetEnv: string,
  client: VercelClient,
  sentryOrgOverride?: string,
  sentryProjectOverride?: string,
): Promise<string> {
  log("Rotating Sentry client key...");

  if (!process.env.SENTRY_AUTH_TOKEN)
    err("SENTRY_AUTH_TOKEN is required for Sentry rotation");

  const org = sentryOrgOverride ?? process.env.SENTRY_ORG;
  const project = sentryProjectOverride ?? process.env.SENTRY_PROJECT;
  if (!org) err("SENTRY_ORG is required for Sentry rotation");
  if (!project) err("SENTRY_PROJECT is required for Sentry rotation");

  const allEnvs = await client.listEnvVars();
  let dsnKeyName = "";
  let currentDsnId = "";
  for (const candidate of ["NEXT_PUBLIC_SENTRY_DSN", "SENTRY_DSN"]) {
    const found = allEnvs.envs.find((e) => e.key === candidate);
    if (found) {
      dsnKeyName = candidate;
      currentDsnId = found.id;
      break;
    }
  }
  if (!dsnKeyName)
    err("Could not find SENTRY_DSN or NEXT_PUBLIC_SENTRY_DSN in Vercel");
  log(`  DSN env var: ${dsnKeyName}`);

  const currentDsn = await client.getEnvVarValue(currentDsnId);
  const currentKeys = await sentryRequest<SentryKey[]>(
    `/projects/${org}/${project}/keys/`,
  );
  const dsnPublicKey = currentDsn.replace(/https?:\/\/([^@]+)@.*/, "$1");
  const oldKey = currentKeys.find((k) =>
    new RegExp(dsnPublicKey, "i").test(k.dsn.public),
  );
  if (!oldKey) {
    warn(
      "Could not match current DSN to a Sentry project key — old key will not be invalidated",
    );
  } else {
    log(`  Current Sentry key ID: ${oldKey.id}`);
  }

  log("  Creating new Sentry project key...");
  const label = `rotated-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
  const newKey = await sentryRequest<SentryKey>(
    `/projects/${org}/${project}/keys/`,
    "POST",
    {
      name: label,
    },
  );
  log(`  New Sentry key ID: ${newKey.id}`);

  for (const vercelEnv of targetEnvs(targetEnv)) {
    const currentEnvs = await client.listEnvVars();
    if (targetEnv === "all") {
      const existing = currentEnvs.envs.find(
        (e) => e.key === dsnKeyName && e.target.includes(vercelEnv),
      );
      if (!existing) {
        log(
          `  [${vercelEnv}] No existing ${dsnKeyName} — skipping (use --env ${vercelEnv} to explicitly add)`,
        );
        continue;
      }
    }
    await client.setEnvForTarget(
      dsnKeyName,
      newKey.dsn.public,
      vercelEnv,
      currentEnvs.envs,
    );
  }

  log("Sentry key rotation complete.");
  return oldKey?.id ?? "";
}

// ─── Sentry init ──────────────────────────────────────────────────────────────

export async function initSentry(
  targetEnv: string,
  client: VercelClient,
  sentryOrgOverride?: string,
  sentryProjectOverride?: string,
): Promise<void> {
  log("Initializing Sentry DSN...");

  if (!process.env.SENTRY_AUTH_TOKEN)
    err("SENTRY_AUTH_TOKEN is required for --init sentry");

  const org = sentryOrgOverride ?? process.env.SENTRY_ORG;
  const project = sentryProjectOverride ?? process.env.SENTRY_PROJECT;
  if (!org) err("SENTRY_ORG is required for --init sentry");
  if (!project) err("SENTRY_PROJECT is required for --init sentry");
  const dsnKeyName = "NEXT_PUBLIC_SENTRY_DSN";

  log("  Creating new Sentry project key...");
  const label = `init-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
  const newKey = await sentryRequest<SentryKey>(
    `/projects/${org}/${project}/keys/`,
    "POST",
    { name: label },
  );
  log(`  New Sentry key ID: ${newKey.id}`);

  const currentEnvs = await client.listEnvVars();
  for (const vercelEnv of targetEnvs(targetEnv)) {
    await client.setEnvForTarget(
      dsnKeyName,
      newKey.dsn.public,
      vercelEnv,
      currentEnvs.envs,
    );
    log(`  [${vercelEnv}] Pushed ${dsnKeyName}`);
  }

  log("Sentry initialization complete.");
}

// ─── Sentry key invalidation ──────────────────────────────────────────────────

export async function invalidateSentryKey(
  oldKeyId: string,
  org: string,
  project: string,
): Promise<void> {
  if (!oldKeyId) {
    warn("No old Sentry key ID recorded — skipping Sentry invalidation");
    return;
  }
  log(`Invalidating old Sentry key: ${oldKeyId}`);
  try {
    await sentryRequest(
      `/projects/${org}/${project}/keys/${oldKeyId}/`,
      "DELETE",
    );
    log("  Old Sentry key deleted.");
  } catch {
    warn(
      `Failed to delete Sentry key ${oldKeyId} — remove it manually in Sentry project settings.`,
    );
  }
}
