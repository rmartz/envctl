import { mkError, mkWarning, type Finding } from "./check";
import { parseDeploymentEnv } from "./environments";
import { resolveFirebaseCredential } from "./firebase-credential";
import { detectEnvPattern, getFirebaseSaForEnv } from "./firebase-vars";
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

    const pattern = detectEnvPattern(liveEnvs, spec.names, target);
    if (!pattern) continue;
    const sa = await getFirebaseSaForEnv(
      target,
      liveEnvs,
      pattern,
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
