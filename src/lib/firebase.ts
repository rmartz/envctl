import * as fs from "fs";
import * as path from "path";

import { err, log, warn } from "./logger";
import { createGcpKey } from "./gcp";
import {
  resolveFirebaseCredential,
  type FirebaseCredentialSpec,
} from "./firebase-credential";
import {
  getFirebaseKeyIdForEnv,
  getFirebaseSaForEnv,
  hasFirebaseCredential,
  hasFirebaseCredentialForEnv,
  type FirebaseSaInfo,
} from "./firebase-vars";
import type { DeploymentProvider } from "./providers/deployment";
import type { VercelEnvVar } from "./vercel-api";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FirebaseIdentity {
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

// Write the split credential for one environment under the resolved names.
// `includeIdentity` also writes the projectId/clientEmail vars — needed on init,
// skipped on a plain rotation where those identity vars are unchanged.
async function writeCredential(
  client: DeploymentProvider,
  names: FirebaseCredentialSpec["names"],
  vercelEnv: string,
  sa: FirebaseSaInfo,
  minted: MintedKey,
  envs: VercelEnvVar[],
  includeIdentity: boolean,
): Promise<void> {
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

// Read the SA identity (email + GCP project) currently in Vercel — the account
// a rotation mints a fresh key for.
async function detectSaIdentity(
  envs: VercelEnvVar[],
  names: FirebaseCredentialSpec["names"],
  client: DeploymentProvider,
): Promise<FirebaseSaInfo> {
  for (const env of ["production", "preview", "development"]) {
    const sa = await getFirebaseSaForEnv(env, envs, names, client);
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

// The GCP project a service-account email belongs to:
// `firebase-adminsdk-…@<project>.iam.gserviceaccount.com` → `<project>`.
// Returns undefined for an unrecognized shape (the caller's guard is
// best-effort — it only fires when the project is unambiguously encoded).
function gcpProjectFromSaEmail(saEmail: string): string | undefined {
  return /@([^.@]+)\.iam\.gserviceaccount\.com$/.exec(saEmail)?.[1];
}

// ─── Firebase rotation ────────────────────────────────────────────────────────

export async function rotateFirebase(
  targetEnv: string,
  client: DeploymentProvider,
  tempDir: string,
  spec: FirebaseCredentialSpec = resolveFirebaseCredential(),
  allowedTargets?: string[],
): Promise<{ oldKeys: OldFirebaseKey[]; fp: FirebaseIdentity }> {
  log("Rotating Firebase service account keys...");

  const { names } = spec;
  let allEnvs = await client.listEnvVars();

  if (!hasFirebaseCredential(allEnvs.envs, names))
    return err("No Firebase service account keys found in Vercel");

  const identity = await detectSaIdentity(allEnvs.envs, names, client);
  const fp: FirebaseIdentity = {
    saEmail: identity.email,
    gcpProject: identity.gcpProject,
    names,
  };

  log(`  Service account : ${fp.saEmail}`);
  log(`  GCP project     : ${fp.gcpProject}`);

  const oldKeys: OldFirebaseKey[] = [];
  let rotatedAny = false;

  for (const vercelEnv of targetEnvs(targetEnv)) {
    // Environment-scoped service (#89): skip targets outside the service's
    // declared scope. rotation.run excludes a service that is wholly out of
    // scope, so at least one target always survives here (no false "no keys
    // rotated" error).
    if (allowedTargets && !allowedTargets.includes(vercelEnv)) continue;
    if (
      targetEnv === "all" &&
      !hasFirebaseCredentialForEnv(allEnvs.envs, names, vercelEnv)
    ) {
      log(
        `  [${vercelEnv}] No existing key — skipping (use --env ${vercelEnv} to explicitly add)`,
      );
      continue;
    }

    const oldKeyId = await getFirebaseKeyIdForEnv(
      vercelEnv,
      allEnvs.envs,
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
      names,
      client,
    );
    if (!envSa) {
      if (vercelEnv !== "production") {
        envSa =
          (await getFirebaseSaForEnv("preview", allEnvs.envs, names, client)) ??
          (await getFirebaseSaForEnv(
            "development",
            allEnvs.envs,
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

    await writeCredential(
      client,
      names,
      vercelEnv,
      envSa,
      minted,
      (await client.listEnvVars()).envs,
      false,
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
  allowedTargets?: string[],
): Promise<void> {
  log("Initializing Firebase service account keys...");

  const currentEnvs = await client.listEnvVars();

  // Resolve the SA identity strictly from THIS target's own declared identity
  // (#126). `init` must never derive the SA from another target's credential (or
  // a local `.env.local`): a blank production target must be minted from
  // production's own `FIREBASE_SA_EMAIL`, not from whatever credential happens to
  // be in scope — cross-deriving pushed staging creds to production. (The run
  // guard already blocks init when the target itself has a credential, so there
  // is nothing on the target to derive from anyway; `rotate` is where an
  // existing credential's identity is reused.) FIREBASE_SA_EMAIL is the
  // deprecated cold-start input; automatic discovery is gated on #70.
  const saEmail = saEmailOverride ?? process.env.FIREBASE_SA_EMAIL;
  if (!saEmail)
    return err(
      `FIREBASE_SA_EMAIL is required for --init firebase (target: ${targetEnv}). Set FIREBASE_SA_EMAIL in the ${targetEnv} deployment YAML or your shell environment.`,
    );
  const gcpProject = gcpProjectOverride ?? process.env.GCLOUD_PROJECT;
  if (!gcpProject)
    return err(
      `GCLOUD_PROJECT is required for --init firebase (target: ${targetEnv}). Set FIREBASE_PROJECT_ID in the ${targetEnv} deployment YAML or GCLOUD_PROJECT in your shell environment.`,
    );

  // Refuse a cross-project mixup (#126): the SA's own project (encoded in its
  // email) must match the target's declared GCP project. A mismatch means the
  // wrong SA email is declared for this environment — never push a foreign
  // project's credential to the target.
  const saProject = gcpProjectFromSaEmail(saEmail);
  if (saProject && saProject !== gcpProject)
    return err(
      `Refusing to init firebase for '${targetEnv}': FIREBASE_SA_EMAIL (${saEmail}) belongs to GCP project '${saProject}', but the target's project is '${gcpProject}'. They must match — check the ${targetEnv} deployment YAML (FIREBASE_SA_EMAIL vs FIREBASE_PROJECT_ID).`,
    );

  warn(
    "FIREBASE_SA_EMAIL is deprecated as a cold-start input — it is only needed for a first-ever (blank) init; `rotate` derives the service account from the target's own credential, and automatic discovery (#70) will remove even the init need.",
  );

  for (const vercelEnv of targetEnvs(targetEnv)) {
    // Environment-scoped service (#89): skip targets outside the service's scope.
    if (allowedTargets && !allowedTargets.includes(vercelEnv)) continue;
    const keyFile = path.join(tempDir, `key-${vercelEnv}.json`);
    createGcpKey(keyFile, saEmail, gcpProject);

    const minted = JSON.parse(fs.readFileSync(keyFile, "utf-8")) as MintedKey;
    log(`  [${vercelEnv}] Created key ID: ${minted.private_key_id}`);
    await writeCredential(
      client,
      spec.names,
      vercelEnv,
      { email: saEmail, gcpProject },
      minted,
      currentEnvs.envs,
      true,
    );
    log(`  [${vercelEnv}] Pushed split Firebase credential vars`);
  }

  log("Firebase initialization complete.");
}
