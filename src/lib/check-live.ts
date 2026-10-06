import { mkError, type Finding } from "./check";
import { checkCollisions } from "./check-collisions";
import {
  checkCompleteness,
  checkServiceContext,
  declaredByEnv,
} from "./check-completeness";
import {
  checkFirebaseProjectDrift,
  checkFirebaseSaDrift,
} from "./check-firebase";
import { deploymentDir } from "./commands/deployment-config";
import { parseManifest } from "./manifest";
import type { DeploymentProvider } from "./providers/deployment";
import { resolveProjectDeployment } from "./providers/registry";
import { envTargetResolver } from "./targets";

// Live reconciliation (`envctl check --live`): compares what the project
// declares against what is actually present on the deployment provider — every
// target's variables against its declared set (missing / orphaned), isolated
// identities across targets (collisions), and the Firebase credential's
// identity against its committed counterparts. Requires network + auth, which
// is why it is behind a flag.
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
  const ctx = checkServiceContext(manifest, deployment);

  // Every target carries exactly what the project declares for it (#175).
  const findings: Finding[] = checkCompleteness(
    declaredByEnv(configDir, manifest, ctx, resolveTarget),
    live,
  );
  // Isolated per-environment identities must not repeat across targets.
  findings.push(...(await checkCollisions(manifest, ctx, live, resolveTarget)));

  // The deprecated FIREBASE_SA_EMAIL must agree with the credential's live
  // clientEmail (#103).
  findings.push(...(await checkFirebaseSaDrift(deployment, configDir, live)));
  // The committed FIREBASE_PROJECT_ID must agree with the credential's live
  // projectId (#121).
  findings.push(
    ...(await checkFirebaseProjectDrift(deployment, configDir, live)),
  );
  return findings;
}
