import { mkError, mkWarning, type Finding } from "./check";
import { checkFirebaseSaDrift } from "./check-firebase";
import { deploymentDir } from "./commands/deployment-config";
import { parseDeploymentEnv } from "./environments";
import { parseManifest } from "./manifest";
import type { DeploymentProvider } from "./providers/deployment";
import { resolveProjectDeployment } from "./providers/registry";
import { envTargetResolver } from "./targets";

// Live reconciliation (`envctl check --live`): compares the public config vars
// the project declares against what is actually present on the deployment
// provider, surfacing drift. Requires network + auth, which is why it is behind
// a flag. Secrets (Firebase/Sentry credentials, generated values) are owned by
// the rotation engine and deliberately out of scope here — this checks the
// public variables `config push` manages, so declared-vs-live stays apples to
// apples.
export async function checkLive(workingDir: string): Promise<Finding[]> {
  const configDir = deploymentDir(workingDir);

  let deployment: DeploymentProvider;
  try {
    deployment = resolveProjectDeployment(configDir, workingDir);
  } catch (e) {
    return [
      mkError(
        `--live check skipped: ${e instanceof Error ? e.message : String(e)}`,
      ),
    ];
  }

  const manifest = parseManifest(configDir);
  const resolveTarget = envTargetResolver(configDir);
  const live = (await deployment.listEnvVars()).envs;

  const findings: Finding[] = [];
  for (const env of manifest.environments) {
    const target = resolveTarget(env);
    const declared = parseDeploymentEnv(configDir, env);
    for (const key of Object.keys(declared)) {
      const present = live.some(
        (e) => e.key === key && e.target.includes(target),
      );
      if (!present)
        findings.push(
          mkWarning(
            `declared variable '${key}' for '${env}' is not present on the '${target}' target (drift).`,
          ),
        );
    }
  }

  // The deprecated FIREBASE_SA_EMAIL must agree with the credential's live
  // clientEmail (#103).
  findings.push(...(await checkFirebaseSaDrift(deployment, configDir, live)));
  return findings;
}
