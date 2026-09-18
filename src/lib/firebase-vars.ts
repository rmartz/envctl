import type { FirebaseCredentialSpec } from "./firebase-credential";
import type { DeploymentProvider } from "./providers/deployment";
import type { VercelEnvVar } from "./vercel-api";

// Low-level readers for the Firebase split credential vars in Vercel,
// parameterized by the resolved credential names (#98) so no var name is
// hardcoded. The credential is always the discrete `split` shape (#102).

type FieldNames = FirebaseCredentialSpec["names"];

export interface FirebaseSaInfo {
  email: string;
  gcpProject: string;
}

// The service-account identity (email + GCP project) for an environment, read
// from the discrete `clientEmail` / `projectId` vars. Returns null when the
// credential is absent for that environment.
export async function getFirebaseSaForEnv(
  vercelEnv: string,
  envs: VercelEnvVar[],
  names: FieldNames,
  client: DeploymentProvider,
): Promise<FirebaseSaInfo | null> {
  const ceRecord = envs.find(
    (e) => e.key === names.clientEmail && e.target.includes(vercelEnv),
  );
  if (!ceRecord) return null;
  const email = await client.getEnvVarValue(ceRecord.id);

  let gcpProject = "";
  const pidRecord = envs.find(
    (e) => e.key === names.projectId && e.target.includes(vercelEnv),
  );
  if (pidRecord) gcpProject = await client.getEnvVarValue(pidRecord.id);
  if (!gcpProject) gcpProject = process.env.GCLOUD_PROJECT ?? "";

  return { email, gcpProject };
}

// The active key id for an environment, from the tracked privateKeyId var.
// "" when untracked.
export async function getFirebaseKeyIdForEnv(
  vercelEnv: string,
  envs: VercelEnvVar[],
  names: FieldNames,
  client: DeploymentProvider,
): Promise<string> {
  const record = envs.find(
    (e) => e.key === names.privateKeyId && e.target.includes(vercelEnv),
  );
  if (!record) return "";
  return client.getEnvVarValue(record.id);
}

// Whether the credential is present anywhere in Vercel (by the resolved names).
export function hasFirebaseCredential(
  envs: VercelEnvVar[],
  names: FieldNames,
): boolean {
  return envs.some((e) => e.key === names.privateKey);
}

// Whether the credential is present in one environment — so per-env reads and
// sweeps skip a target that has no credential.
export function hasFirebaseCredentialForEnv(
  envs: VercelEnvVar[],
  names: FieldNames,
  vercelEnv: string,
): boolean {
  return envs.some(
    (e) => e.key === names.privateKey && e.target.includes(vercelEnv),
  );
}
