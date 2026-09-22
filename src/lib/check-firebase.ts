import { mkError, mkWarning, type Finding } from "./check";
import { parseDeploymentEnv } from "./environments";
import { resolveFirebaseCredential } from "./firebase-credential";
import {
  getFirebaseSaForEnv,
  hasFirebaseCredentialForEnv,
} from "./firebase-vars";
import { parseManifest } from "./manifest";
import type { DeploymentProvider } from "./providers/deployment";
import { envTargetResolver } from "./targets";
import type { VercelEnvVar } from "./vercel-api";

// #103: `FIREBASE_SA_EMAIL` is a deprecated committed var that duplicates the
// service-account identity the app already reads from the credential's
// `clientEmail`. This flags a project that still declares it against the live
// credential — an **error** when the two name different service accounts (the
// drift class #97/#98 were created to kill: envctl would mint keys for one SA
// while the app authenticates as another), a deprecation **warning** when it
// merely duplicates the credential. Part of `envctl check --live`, since the
// credential's value lives in the provider, not in git.
export async function checkFirebaseSaDrift(
  deployment: DeploymentProvider,
  configDir: string,
  liveEnvs: VercelEnvVar[],
): Promise<Finding[]> {
  const manifest = parseManifest(configDir);
  const spec = resolveFirebaseCredential(
    manifest.services.find((s) => s.provider === "firebase"),
  );
  const resolveTarget = envTargetResolver(configDir);
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const env of manifest.environments) {
    const declared = parseDeploymentEnv(configDir, env).FIREBASE_SA_EMAIL;
    if (!declared) continue;
    const target = resolveTarget(env);
    const seenKey = `${target}|${declared}`;
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);

    if (!hasFirebaseCredentialForEnv(liveEnvs, spec.names, target)) continue;
    const sa = await getFirebaseSaForEnv(
      target,
      liveEnvs,
      spec.names,
      deployment,
    );
    if (!sa?.email) continue;

    findings.push(
      sa.email === declared
        ? mkWarning(
            `FIREBASE_SA_EMAIL for '${env}' duplicates the credential's ${spec.names.clientEmail} — it is deprecated; remove it and let envctl derive the service account from the credential.`,
          )
        : mkError(
            `FIREBASE_SA_EMAIL for '${env}' (${declared}) disagrees with the credential's ${spec.names.clientEmail} (${sa.email}) on the '${target}' target — they name different service accounts. Remove the deprecated FIREBASE_SA_EMAIL and let envctl derive the identity from the credential.`,
          ),
    );
  }
  return findings;
}

// #121: the committed `FIREBASE_PROJECT_ID` (a public var in `deployment/{env}.yml`)
// is the target's own GCP project — the project envctl mints keys in at init, and
// the same project the app's credential authenticates against (the credential's
// `projectId` var). If the two disagree, envctl would mint keys in one GCP
// project while the app runs against another — the projectId analog of the
// SA-email drift #103 addressed. Unlike `FIREBASE_SA_EMAIL`, `FIREBASE_PROJECT_ID`
// is **not** deprecated: #127 established that init must resolve the project
// strictly from the target's own declared value, so a matching committed value is
// correct and required — only a mismatch (drift) is flagged, as an error. Part of
// `envctl check --live` (the credential's value lives in the provider, not git);
// deferred to this follow-up by #127.
export async function checkFirebaseProjectDrift(
  deployment: DeploymentProvider,
  configDir: string,
  liveEnvs: VercelEnvVar[],
): Promise<Finding[]> {
  const manifest = parseManifest(configDir);
  const spec = resolveFirebaseCredential(
    manifest.services.find((s) => s.provider === "firebase"),
  );
  const resolveTarget = envTargetResolver(configDir);
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const env of manifest.environments) {
    const declared = parseDeploymentEnv(configDir, env).FIREBASE_PROJECT_ID;
    if (!declared) continue;
    const target = resolveTarget(env);
    const seenKey = `${target}|${declared}`;
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);

    if (!hasFirebaseCredentialForEnv(liveEnvs, spec.names, target)) continue;
    const sa = await getFirebaseSaForEnv(
      target,
      liveEnvs,
      spec.names,
      deployment,
    );
    if (!sa?.gcpProject) continue;

    if (sa.gcpProject !== declared)
      findings.push(
        mkError(
          `FIREBASE_PROJECT_ID for '${env}' (${declared}) disagrees with the credential's ${spec.names.projectId} (${sa.gcpProject}) on the '${target}' target — envctl would mint keys in one GCP project while the app authenticates against another. Reconcile the committed FIREBASE_PROJECT_ID with the live credential.`,
        ),
      );
  }
  return findings;
}
