import type {
  FirebaseCredentialSpec,
  FirebasePatternKind,
} from "./firebase-credential";
import type { DeploymentProvider } from "./providers/deployment";
import type { VercelEnvVar } from "./vercel-api";

// Low-level readers for Firebase credential vars in Vercel, parameterized by the
// resolved credential names (#98) and shape (#97) so no var name is hardcoded.

type FieldNames = FirebaseCredentialSpec["names"];

export interface FirebaseSaInfo {
  email: string;
  gcpProject: string;
}

// The service-account identity (email + GCP project) for an environment, read
// under the given shape: from the JSON blob (`json`) or the discrete vars
// (`split`). Returns null when the credential is absent for that environment.
export async function getFirebaseSaForEnv(
  vercelEnv: string,
  envs: VercelEnvVar[],
  pattern: FirebasePatternKind,
  names: FieldNames,
  client: DeploymentProvider,
): Promise<FirebaseSaInfo | null> {
  if (pattern === "json") {
    const record = envs.find(
      (e) => e.key === names.serviceAccount && e.target.includes(vercelEnv),
    );
    if (!record) return null;
    const saJson = JSON.parse(await client.getEnvVarValue(record.id)) as {
      client_email: string;
      project_id: string;
    };
    return { email: saJson.client_email, gcpProject: saJson.project_id };
  }

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

// The active key id for an environment: from the JSON blob's `private_key_id`
// (`json`) or the tracked privateKeyId var (`split`). "" when untracked.
export async function getFirebaseKeyIdForEnv(
  vercelEnv: string,
  envs: VercelEnvVar[],
  pattern: FirebasePatternKind,
  names: FieldNames,
  client: DeploymentProvider,
): Promise<string> {
  if (pattern === "json") {
    const record = envs.find(
      (e) => e.key === names.serviceAccount && e.target.includes(vercelEnv),
    );
    if (!record) return "";
    const saJson = JSON.parse(await client.getEnvVarValue(record.id)) as {
      private_key_id: string;
    };
    return saJson.private_key_id;
  }

  const record = envs.find(
    (e) => e.key === names.privateKeyId && e.target.includes(vercelEnv),
  );
  if (!record) return "";
  return client.getEnvVarValue(record.id);
}

// The credential shape present anywhere in Vercel (by the resolved names),
// independent of what the manifest declares — the shape rotate migrates *from*.
export function detectExistingPattern(
  envs: VercelEnvVar[],
  names: FieldNames,
): FirebasePatternKind | undefined {
  if (envs.some((e) => e.key === names.serviceAccount)) return "json";
  if (envs.some((e) => e.key === names.privateKey)) return "split";
  return undefined;
}

// The credential shape present in one environment — so sweeps read each env
// under its own shape even mid-migration.
export function detectEnvPattern(
  envs: VercelEnvVar[],
  names: FieldNames,
  vercelEnv: string,
): FirebasePatternKind | undefined {
  if (
    envs.some(
      (e) => e.key === names.serviceAccount && e.target.includes(vercelEnv),
    )
  )
    return "json";
  if (
    envs.some((e) => e.key === names.privateKey && e.target.includes(vercelEnv))
  )
    return "split";
  return undefined;
}
