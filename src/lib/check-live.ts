import * as path from "path";

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
import { checkForeignServiceVars } from "./check-services";
import { deploymentDir } from "./commands/deployment-config";
import { checkGithubSecrets, resolveGithubSecrets } from "./github-secrets";
import {
  manifestErrors,
  parseManifest,
  type DeploymentDecl,
  type ResolvedManifest,
} from "./manifest";
import type { DeploymentProvider } from "./providers/deployment";
import { resolveProjectDeployment } from "./providers/registry";
import { envTargetResolver } from "./targets";

// Live reconciliation (`envctl check --live`): compares what the project
// declares against what is actually present on the deployment provider — every
// target's variables against its declared set (missing / orphaned), isolated
// identities across targets (collisions), and the Firebase credential's
// identity against its committed counterparts. Requires network + auth, which
// is why it is behind a flag. A multi-deployment root is reconciled one
// deployment at a time through its view (#215), each also checked for another
// deployment's service variables.
export async function checkLive(workingDir: string): Promise<Finding[]> {
  const configDir = deploymentDir(workingDir);
  let root: ResolvedManifest;
  try {
    root = parseManifest(configDir);
  } catch (e) {
    return [skipped(e)];
  }
  if (root.deployments.length <= 1) return checkLiveDir(workingDir, configDir);
  // An invalid root can't be resolved per deployment; static check reports why.
  if (manifestErrors(root).length > 0) return [];

  const findings: Finding[] = [];
  for (const deployment of root.deployments) {
    const dir = path.join(configDir, deployment.name);
    const found = await checkLiveDir(workingDir, dir, { root, deployment });
    findings.push(
      ...found.map((f) =>
        f.message.includes(`'${deployment.name}'`)
          ? f
          : { ...f, message: `deployment '${deployment.name}': ${f.message}` },
      ),
    );
  }
  return findings;
}

function skipped(e: unknown): Finding {
  return mkError(
    `--live check skipped: ${e instanceof Error ? e.message : String(e)}`,
  );
}

async function checkLiveDir(
  workingDir: string,
  configDir: string,
  shared?: { root: ResolvedManifest; deployment: DeploymentDecl },
): Promise<Finding[]> {
  let deployment: DeploymentProvider;
  try {
    deployment = resolveProjectDeployment(configDir, workingDir);
  } catch (e) {
    return [skipped(e)];
  }

  const manifest = parseManifest(configDir);
  const resolveTarget = envTargetResolver(configDir);
  const live = (await deployment.listEnvVars()).envs;
  const ctx = checkServiceContext(manifest, deployment);
  const declarations = declaredByEnv(configDir, manifest, ctx, resolveTarget);

  // Every target carries exactly what the project declares for it (#175).
  const findings: Finding[] = checkCompleteness(declarations, live);
  // No variable of a service this deployment doesn't list (#215).
  if (shared)
    findings.push(
      ...checkForeignServiceVars(
        shared.root,
        shared.deployment,
        new Set(declarations.flatMap((d) => [...d.known])),
        live,
      ),
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
  // Declared GitHub Actions secrets must exist (#198); values are write-only.
  findings.push(...checkGithubSecrets(resolveGithubSecrets(configDir)));
  return findings;
}
