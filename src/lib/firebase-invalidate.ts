import type { FirebasePattern } from "./firebase";
import {
  detectEnvPattern,
  getFirebaseKeyIdForEnv,
  getFirebaseSaForEnv,
} from "./firebase-vars";
import { deleteGcpKey, listUserManagedGcpKeys } from "./gcp";
import { log, warn } from "./logger";
import type { DeploymentProvider } from "./providers/deployment";

// Post-redeploy cleanup: once a rotation's new key is proven live, sweep every
// non-active user-managed key for each service account so old credentials can't
// be used. Kept separate from the mint/rotate/init flow (firebase.ts) as its own
// concern.
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
