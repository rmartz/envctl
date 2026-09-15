import * as fs from "fs";
import * as path from "path";

import { err, log, warn } from "./logger";
import { createGcpKey, deleteGcpKey, listUserManagedGcpKeys } from "./gcp";
import {
  firebasePresenceKeys,
  patternVarNames,
  resolveFirebaseCredential,
  type FirebaseCredentialSpec,
  type FirebasePatternKind,
} from "./firebase-credential";
import {
  detectEnvPattern,
  detectExistingPattern,
  getFirebaseKeyIdForEnv,
  getFirebaseSaForEnv,
  type FirebaseSaInfo,
} from "./firebase-vars";
import type { DeploymentProvider } from "./providers/deployment";
import type { VercelEnvVar } from "./vercel-api";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FirebasePattern {
  pattern: FirebasePatternKind;
  saEmail: string;
  gcpProject: string;
  /** Resolved credential var names for this project (#98). */
  names: FirebaseCredentialSpec["names"];
}

export interface OldFirebaseKey {
  vercelEnv: string;
  keyId: string;
  saEmail: string;
  gcpProject: string;
}

interface MintedKey {
  private_key_id: string;
  private_key: string;
  [key: string]: unknown;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function targetEnvs(targetEnv: string): string[] {
  if (targetEnv === "all") return ["production", "preview", "development"];
  return [targetEnv];
}

// Write the credential for one environment under the given shape + resolved
// names. `includeIdentity` also writes the split projectId/clientEmail vars —
// needed on init and on a json→split migration, skipped on a plain split
// rotation where those identity vars are unchanged.
async function writeCredential(
  client: DeploymentProvider,
  pattern: FirebasePatternKind,
  names: FirebaseCredentialSpec["names"],
  vercelEnv: string,
  sa: FirebaseSaInfo,
  minted: MintedKey,
  envs: VercelEnvVar[],
  includeIdentity: boolean,
): Promise<void> {
  if (pattern === "json") {
    await client.setEnvForTarget(
      names.serviceAccount,
      JSON.stringify(minted),
      vercelEnv,
      envs,
    );
    return;
  }
  if (includeIdentity) {
    await client.setEnvForTarget(
      names.projectId,
      sa.gcpProject,
      vercelEnv,
      envs,
    );
    await client.setEnvForTarget(names.clientEmail, sa.email, vercelEnv, envs);
  }
  await client.setEnvForTarget(
    names.privateKey,
    minted.private_key,
    vercelEnv,
    envs,
  );
  await client.setEnvForTarget(
    names.privateKeyId,
    minted.private_key_id,
    vercelEnv,
    envs,
  );
}

// Remove the given vars for one environment (used to sweep the old shape's
// now-stale credential vars after a migration). Vercel env-var records can
// cover multiple targets; for shared records only the specific target is
// removed to avoid silently dropping the credential from other environments.
async function removeVars(
  client: DeploymentProvider,
  keys: string[],
  vercelEnv: string,
  envs: VercelEnvVar[],
): Promise<void> {
  for (const key of keys) {
    const existing = client.findEnvVar(envs, key, vercelEnv);
    if (existing)
      await client.removeEnvVarFromTarget(
        existing.id,
        existing.target,
        vercelEnv,
      );
  }
}

// Read the SA identity (email + GCP project) currently in Vercel, under the
// existing shape — the account a rotation mints a fresh key for.
async function detectSaIdentity(
  envs: VercelEnvVar[],
  pattern: FirebasePatternKind,
  names: FirebaseCredentialSpec["names"],
  client: DeploymentProvider,
): Promise<FirebaseSaInfo> {
  for (const env of ["production", "preview", "development"]) {
    const sa = await getFirebaseSaForEnv(env, envs, pattern, names, client);
    if (sa?.email) {
      const gcpProject = process.env.GCLOUD_PROJECT ?? sa.gcpProject;
      if (!gcpProject)
        return err(
          "Could not determine GCP project: set GCLOUD_PROJECT or ensure the Firebase project id var is present in Vercel",
        );
      return { email: sa.email, gcpProject };
    }
  }
  return err(
    "Could not determine Firebase service account identity from Vercel",
  );
}

// ─── Firebase rotation ────────────────────────────────────────────────────────

export async function rotateFirebase(
  targetEnv: string,
  client: DeploymentProvider,
  tempDir: string,
  spec: FirebaseCredentialSpec = resolveFirebaseCredential(),
): Promise<{ oldKeys: OldFirebaseKey[]; fp: FirebasePattern }> {
  log("Rotating Firebase service account keys...");

  const { names } = spec;
  const declaredPattern = spec.pattern;
  let allEnvs = await client.listEnvVars();

  const existingPattern = detectExistingPattern(allEnvs.envs, names);
  if (!existingPattern)
    return err("No Firebase service account keys found in Vercel");

  const identity = await detectSaIdentity(
    allEnvs.envs,
    existingPattern,
    names,
    client,
  );
  const migrating = existingPattern !== declaredPattern;
  const fp: FirebasePattern = {
    pattern: declaredPattern,
    saEmail: identity.email,
    gcpProject: identity.gcpProject,
    names,
  };

  log(
    `  Credential shape: ${existingPattern}${migrating ? ` → migrating to ${declaredPattern}` : ""}`,
  );
  log(`  Service account : ${fp.saEmail}`);
  log(`  GCP project     : ${fp.gcpProject}`);

  const presenceKeys = firebasePresenceKeys(spec);
  const oldKeys: OldFirebaseKey[] = [];
  let rotatedAny = false;

  for (const vercelEnv of targetEnvs(targetEnv)) {
    if (targetEnv === "all") {
      const hasKey = presenceKeys.some((k) =>
        allEnvs.envs.some((e) => e.key === k && e.target.includes(vercelEnv)),
      );
      if (!hasKey) {
        log(
          `  [${vercelEnv}] No existing key — skipping (use --env ${vercelEnv} to explicitly add)`,
        );
        continue;
      }
    }

    const envPattern =
      detectEnvPattern(allEnvs.envs, names, vercelEnv) ?? existingPattern;
    const oldKeyId = await getFirebaseKeyIdForEnv(
      vercelEnv,
      allEnvs.envs,
      envPattern,
      names,
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
      envPattern,
      names,
      client,
    );
    if (!envSa) {
      if (vercelEnv !== "production") {
        envSa =
          (await getFirebaseSaForEnv(
            "preview",
            allEnvs.envs,
            existingPattern,
            names,
            client,
          )) ??
          (await getFirebaseSaForEnv(
            "development",
            allEnvs.envs,
            existingPattern,
            names,
            client,
          ));
      }
      envSa ??= { email: fp.saEmail, gcpProject: fp.gcpProject };
    }

    log(`  [${vercelEnv}] Rotating... (SA: ${envSa.email})`);

    const keyFile = path.join(tempDir, `key-${vercelEnv}.json`);
    createGcpKey(keyFile, envSa.email, envSa.gcpProject);

    const minted = JSON.parse(fs.readFileSync(keyFile, "utf-8")) as MintedKey;
    log(`  [${vercelEnv}] New key ID: ${minted.private_key_id}`);

    const migratingEnv = envPattern !== declaredPattern;
    await writeCredential(
      client,
      declaredPattern,
      names,
      vercelEnv,
      envSa,
      minted,
      (await client.listEnvVars()).envs,
      migratingEnv,
    );

    // Always remove the non-declared shape's vars after writing the declared
    // shape. removeVars is idempotent (skips absent vars), so this is safe for
    // plain rotations too. Removing unconditionally (not only when migrating)
    // makes the migration retry-safe: an interrupted split→json migration
    // leaves both shapes present; on retry detectEnvPattern returns json
    // (migratingEnv = false), but the stale split vars still need to go.
    const stalePattern: FirebasePatternKind =
      declaredPattern === "json" ? "split" : "json";
    await removeVars(
      client,
      patternVarNames(names, stalePattern),
      vercelEnv,
      (await client.listEnvVars()).envs,
    );

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
  client: DeploymentProvider,
  tempDir: string,
  saEmailOverride?: string,
  gcpProjectOverride?: string,
  spec: FirebaseCredentialSpec = resolveFirebaseCredential(),
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

    const minted = JSON.parse(fs.readFileSync(keyFile, "utf-8")) as MintedKey;
    log(`  [${vercelEnv}] Created key ID: ${minted.private_key_id}`);
    await writeCredential(
      client,
      spec.pattern,
      spec.names,
      vercelEnv,
      { email: saEmail, gcpProject },
      minted,
      currentEnvs.envs,
      true,
    );
    log(
      `  [${vercelEnv}] Pushed ${spec.pattern === "json" ? spec.names.serviceAccount : "split Firebase credential vars"}`,
    );
  }

  log("Firebase initialization complete.");
}

// ─── Firebase key invalidation ────────────────────────────────────────────────

export async function invalidateFirebaseKeys(
  client: DeploymentProvider,
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
    // Read each environment under its own shape, so a mid-migration project is
    // never misread (which could sweep a still-active key).
    const envPattern = detectEnvPattern(allEnvs.envs, fp.names, checkEnv);
    if (!envPattern) continue;

    const kid = await getFirebaseKeyIdForEnv(
      checkEnv,
      allEnvs.envs,
      envPattern,
      fp.names,
      client,
    );
    const saInfo = await getFirebaseSaForEnv(
      checkEnv,
      allEnvs.envs,
      envPattern,
      fp.names,
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
        `Skipping stray-key sweep for ${saEmail} — not all environments have the key id tracked.`,
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
