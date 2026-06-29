import * as fs from "fs";
import * as path from "path";

import { err, log, warn } from "./logger";
import { createGcpKey, deleteGcpKey, listUserManagedGcpKeys } from "./gcp";
import { VercelClient, VercelEnvVar } from "./vercel-api";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FirebasePattern {
  pattern: "json" | "split";
  saEmail: string;
  gcpProject: string;
}

interface FirebaseSaInfo {
  email: string;
  gcpProject: string;
}

export interface OldFirebaseKey {
  vercelEnv: string;
  keyId: string;
  saEmail: string;
  gcpProject: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function targetEnvs(targetEnv: string): string[] {
  if (targetEnv === "all") return ["production", "preview", "development"];
  return [targetEnv];
}

async function getFirebaseSaForEnv(
  vercelEnv: string,
  envs: VercelEnvVar[],
  pattern: "json" | "split",
  client: VercelClient,
): Promise<FirebaseSaInfo | null> {
  if (pattern === "json") {
    const record = envs.find(
      (e) =>
        e.key === "FIREBASE_SERVICE_ACCOUNT" && e.target.includes(vercelEnv),
    );
    if (!record) return null;
    const saJson = JSON.parse(await client.getEnvVarValue(record.id)) as {
      client_email: string;
      project_id: string;
    };
    return { email: saJson.client_email, gcpProject: saJson.project_id };
  }

  const ceRecord = envs.find(
    (e) => e.key === "FIREBASE_CLIENT_EMAIL" && e.target.includes(vercelEnv),
  );
  if (!ceRecord) return null;
  const email = await client.getEnvVarValue(ceRecord.id);

  let gcpProject = "";
  const pidRecord = envs.find(
    (e) => e.key === "FIREBASE_PROJECT_ID" && e.target.includes(vercelEnv),
  );
  if (pidRecord) gcpProject = await client.getEnvVarValue(pidRecord.id);
  if (!gcpProject) gcpProject = process.env.GCLOUD_PROJECT ?? "";

  return { email, gcpProject };
}

async function getFirebaseKeyIdForEnv(
  vercelEnv: string,
  envs: VercelEnvVar[],
  pattern: "json" | "split",
  client: VercelClient,
): Promise<string> {
  if (pattern === "json") {
    const record = envs.find(
      (e) =>
        e.key === "FIREBASE_SERVICE_ACCOUNT" && e.target.includes(vercelEnv),
    );
    if (!record) return "";
    const saJson = JSON.parse(await client.getEnvVarValue(record.id)) as {
      private_key_id: string;
    };
    return saJson.private_key_id;
  }

  const record = envs.find(
    (e) => e.key === "FIREBASE_PRIVATE_KEY_ID" && e.target.includes(vercelEnv),
  );
  if (!record) return "";
  return client.getEnvVarValue(record.id);
}

// ─── Firebase pattern detection ───────────────────────────────────────────────

export function detectFirebasePattern(
  envs: VercelEnvVar[],
  client: VercelClient,
): Promise<FirebasePattern> {
  return _detectFirebasePattern(envs, client);
}

async function _detectFirebasePattern(
  envs: VercelEnvVar[],
  client: VercelClient,
): Promise<FirebasePattern> {
  const saJsonRecords = envs.filter(
    (e) => e.key === "FIREBASE_SERVICE_ACCOUNT",
  );
  const privateKeyRecords = envs.filter(
    (e) => e.key === "FIREBASE_PRIVATE_KEY",
  );

  if (saJsonRecords.length > 0) {
    const saJson = JSON.parse(
      await client.getEnvVarValue(saJsonRecords[0].id),
    ) as {
      client_email: string;
      project_id: string;
    };
    return {
      pattern: "json",
      saEmail: saJson.client_email,
      gcpProject: process.env.GCLOUD_PROJECT ?? saJson.project_id,
    };
  }

  if (privateKeyRecords.length > 0) {
    const ceRecords = envs.filter((e) => e.key === "FIREBASE_CLIENT_EMAIL");
    if (ceRecords.length === 0)
      err(
        "FIREBASE_CLIENT_EMAIL not found in Vercel (required alongside FIREBASE_PRIVATE_KEY)",
      );

    const saEmail = await client.getEnvVarValue(ceRecords[0].id);
    let gcpProject = process.env.GCLOUD_PROJECT ?? "";
    if (!gcpProject) {
      const pidRecords = envs.filter((e) => e.key === "FIREBASE_PROJECT_ID");
      if (pidRecords.length > 0)
        gcpProject = await client.getEnvVarValue(pidRecords[0].id);
    }
    if (!gcpProject)
      err(
        "Could not determine GCP project: set GCLOUD_PROJECT or ensure FIREBASE_PROJECT_ID is present in Vercel",
      );
    return { pattern: "split", saEmail, gcpProject };
  }

  return err("No Firebase service account keys found in Vercel");
}

// ─── Firebase rotation ────────────────────────────────────────────────────────

export async function rotateFirebase(
  targetEnv: string,
  client: VercelClient,
  tempDir: string,
): Promise<{ oldKeys: OldFirebaseKey[]; fp: FirebasePattern }> {
  log("Rotating Firebase service account keys...");

  let allEnvs = await client.listEnvVars();
  const fp = await _detectFirebasePattern(allEnvs.envs, client);
  log(`  Key pattern: ${fp.pattern}`);
  log(`  Service account : ${fp.saEmail}`);
  log(`  GCP project     : ${fp.gcpProject}`);

  const oldKeys: OldFirebaseKey[] = [];
  let rotatedAny = false;
  const firebaseKeyName =
    fp.pattern === "json" ? "FIREBASE_SERVICE_ACCOUNT" : "FIREBASE_PRIVATE_KEY";

  for (const vercelEnv of targetEnvs(targetEnv)) {
    if (targetEnv === "all") {
      const hasKey = allEnvs.envs.some(
        (e) => e.key === firebaseKeyName && e.target.includes(vercelEnv),
      );
      if (!hasKey) {
        log(
          `  [${vercelEnv}] No existing key — skipping (use --env ${vercelEnv} to explicitly add)`,
        );
        continue;
      }
    }

    const oldKeyId = await getFirebaseKeyIdForEnv(
      vercelEnv,
      allEnvs.envs,
      fp.pattern,
      client,
    );
    if (oldKeyId) {
      log(`  [${vercelEnv}] Current key ID: ${oldKeyId}`);
    } else {
      log(
        `  [${vercelEnv}] No key ID tracked — old key will be swept after redeployment`,
      );
    }

    let envSa = await getFirebaseSaForEnv(
      vercelEnv,
      allEnvs.envs,
      fp.pattern,
      client,
    );
    if (!envSa) {
      if (vercelEnv !== "production") {
        envSa =
          (await getFirebaseSaForEnv(
            "preview",
            allEnvs.envs,
            fp.pattern,
            client,
          )) ??
          (await getFirebaseSaForEnv(
            "development",
            allEnvs.envs,
            fp.pattern,
            client,
          ));
      }
      envSa ??= { email: fp.saEmail, gcpProject: fp.gcpProject };
    }

    log(`  [${vercelEnv}] Rotating... (SA: ${envSa.email})`);

    const keyFile = path.join(tempDir, `key-${vercelEnv}.json`);
    createGcpKey(keyFile, envSa.email, envSa.gcpProject);

    const newSaJson = JSON.parse(fs.readFileSync(keyFile, "utf-8")) as {
      private_key_id: string;
      private_key: string;
      [key: string]: unknown;
    };
    log(`  [${vercelEnv}] New key ID: ${newSaJson.private_key_id}`);

    const currentEnvs = await client.listEnvVars();
    if (fp.pattern === "json") {
      await client.setEnvForTarget(
        "FIREBASE_SERVICE_ACCOUNT",
        JSON.stringify(newSaJson),
        vercelEnv,
        currentEnvs.envs,
      );
    } else {
      await client.setEnvForTarget(
        "FIREBASE_PRIVATE_KEY",
        newSaJson.private_key,
        vercelEnv,
        currentEnvs.envs,
      );
      await client.setEnvForTarget(
        "FIREBASE_PRIVATE_KEY_ID",
        newSaJson.private_key_id,
        vercelEnv,
        currentEnvs.envs,
      );
    }

    if (oldKeyId) {
      oldKeys.push({
        vercelEnv,
        keyId: oldKeyId,
        saEmail: envSa.email,
        gcpProject: envSa.gcpProject,
      });
    }

    allEnvs = await client.listEnvVars();
    rotatedAny = true;
  }

  if (!rotatedAny)
    err("No Firebase keys rotated — check --env and project configuration");
  log("Firebase key rotation complete.");
  return { oldKeys, fp };
}

// ─── Firebase init ────────────────────────────────────────────────────────────

export async function initFirebase(
  targetEnv: string,
  client: VercelClient,
  tempDir: string,
  saEmailOverride?: string,
  gcpProjectOverride?: string,
): Promise<void> {
  log("Initializing Firebase service account keys...");

  const saEmail = saEmailOverride ?? process.env.FIREBASE_SA_EMAIL;
  if (!saEmail)
    return err(
      `FIREBASE_SA_EMAIL is required for --init firebase (target: ${targetEnv}). Set FIREBASE_SA_EMAIL in your deployment YAML or shell environment.`,
    );
  const gcpProject = gcpProjectOverride ?? process.env.GCLOUD_PROJECT;
  if (!gcpProject)
    return err(
      `GCLOUD_PROJECT is required for --init firebase (target: ${targetEnv}). Set FIREBASE_PROJECT_ID in your deployment YAML or GCLOUD_PROJECT in your shell environment.`,
    );

  const currentEnvs = await client.listEnvVars();
  for (const vercelEnv of targetEnvs(targetEnv)) {
    const keyFile = path.join(tempDir, `key-${vercelEnv}.json`);
    createGcpKey(keyFile, saEmail, gcpProject);

    const newSaJson = JSON.parse(fs.readFileSync(keyFile, "utf-8")) as {
      private_key_id: string;
      [key: string]: unknown;
    };
    log(`  [${vercelEnv}] Created key ID: ${newSaJson.private_key_id}`);
    await client.setEnvForTarget(
      "FIREBASE_SERVICE_ACCOUNT",
      JSON.stringify(newSaJson),
      vercelEnv,
      currentEnvs.envs,
    );
    log(`  [${vercelEnv}] Pushed FIREBASE_SERVICE_ACCOUNT`);
  }

  log("Firebase initialization complete.");
}

// ─── Firebase key invalidation ────────────────────────────────────────────────

export async function invalidateFirebaseKeys(
  client: VercelClient,
  fp: FirebasePattern,
): Promise<void> {
  log(
    "Invalidating old Firebase keys (sweeping all non-active user-managed keys)...",
  );

  const allEnvs = await client.listEnvVars();
  const activeKeys = new Set<string>();
  const saPairs = new Map<string, string>(); // email → gcpProject
  const unsweepable = new Set<string>();

  for (const checkEnv of ["production", "preview", "development"]) {
    const kid = await getFirebaseKeyIdForEnv(
      checkEnv,
      allEnvs.envs,
      fp.pattern,
      client,
    );
    const saInfo = await getFirebaseSaForEnv(
      checkEnv,
      allEnvs.envs,
      fp.pattern,
      client,
    );

    if (kid) {
      activeKeys.add(kid);
      log(`  Active key [${checkEnv}]: ${kid}`);
    }
    if (saInfo) {
      saPairs.set(saInfo.email, saInfo.gcpProject);
      if (!kid) unsweepable.add(saInfo.email);
    }
  }

  for (const [saEmail, gcpProject] of saPairs) {
    if (unsweepable.has(saEmail)) {
      warn(
        `Skipping stray-key sweep for ${saEmail} — not all environments have FIREBASE_PRIVATE_KEY_ID tracked.`,
      );
      warn("  Rotate all environments first, then re-run to sweep old keys.");
      continue;
    }
    log(`  Sweeping SA: ${saEmail}`);
    const allKeys = listUserManagedGcpKeys(saEmail, gcpProject);
    let deleted = 0;
    for (const keyId of allKeys) {
      if (activeKeys.has(keyId)) continue;
      log(`  Deleting stray key: ${keyId}`);
      try {
        deleteGcpKey(keyId, saEmail, gcpProject);
        log(`  Deleted: ${keyId}`);
        deleted++;
      } catch {
        warn(`Failed to delete key ${keyId} — remove manually:`);
        warn(
          `  gcloud iam service-accounts keys delete ${keyId} --iam-account=${saEmail}`,
        );
      }
    }
    if (deleted === 0) log(`  No stray keys for ${saEmail}.`);
    else log(`  Deleted ${deleted} stray key(s) for ${saEmail}.`);
  }
}
