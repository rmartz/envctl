import { parseDeploymentEnv } from "../environments";
import { err, log } from "../logger";

// Init-mode planning: resolve `--init auto` to a concrete service from the
// deployment config, and validate that the config required to initialize the
// chosen service(s) is present. Ported from the predecessor's sync-env
// orchestration; rotation itself lives in the shared engine.

// The Sentry secret is project-wide, so it is sourced from a single active
// environment: the first non-development one, falling back to development's
// source (staging) or the first env in the list.
function sentrySourceEnv(
  targetEnv: string,
  envList: string[],
  devSource: string | undefined,
): string | undefined {
  if (targetEnv === "all")
    return envList.find((e) => e !== "development") ?? envList[0];
  if (targetEnv === "development") return devSource;
  return targetEnv;
}

// Resolves `--init auto` by scanning the deployment config for public vars that
// indicate which services are in use. Errors if neither is configured.
export function resolveAutoInit(
  deploymentDir: string,
  targetEnv: string,
  envList: string[],
  devSource: string | undefined,
): "all" | "firebase" | "sentry" {
  // development has no own YAML — scan its source (staging) instead.
  const scanEnvs =
    targetEnv === "development"
      ? devSource
        ? [devSource]
        : []
      : targetEnv === "all"
        ? envList
        : [targetEnv];

  const keys = scanEnvs.flatMap((envName) =>
    Object.keys(parseDeploymentEnv(deploymentDir, envName)),
  );

  const hasFirebase = keys.some((k) =>
    [
      "FIREBASE_PROJECT_ID",
      "FIREBASE_SA_EMAIL",
      "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
    ].includes(k),
  );
  const hasSentry = keys.some((k) =>
    ["SENTRY_ORG", "SENTRY_PROJECT"].includes(k),
  );

  log("Auto-detecting secrets to initialize:");
  log(
    hasFirebase
      ? "  Firebase: initialize (Firebase public vars found)"
      : "  Firebase: skip (no Firebase public vars)",
  );
  log(
    hasSentry
      ? "  Sentry: initialize (Sentry public vars found)"
      : "  Sentry: skip (no Sentry public vars)",
  );

  if (!hasFirebase && !hasSentry)
    err(
      "secrets init: nothing to initialize — no Firebase or Sentry public config vars found in the deployment config",
    );

  if (hasFirebase && hasSentry) return "all";
  if (hasFirebase) return "firebase";
  return "sentry";
}

function firebaseConfigMissing(
  deploymentDir: string,
  envName: string,
  label: string,
): string[] {
  const envVars = parseDeploymentEnv(deploymentDir, envName);
  const missing: string[] = [];
  if (!envVars.FIREBASE_SA_EMAIL && !process.env.FIREBASE_SA_EMAIL)
    missing.push(
      `FIREBASE_SA_EMAIL [${label}]: add to ${envName}.yml or export in shell`,
    );
  if (!envVars.FIREBASE_PROJECT_ID && !process.env.GCLOUD_PROJECT)
    missing.push(
      `FIREBASE_PROJECT_ID [${label}]: add to ${envName}.yml or export GCLOUD_PROJECT in shell`,
    );
  return missing;
}

// Validates that the config needed to initialize the chosen service(s) is
// present (in the deployment YAML or shell env), erroring with every gap at once.
export function validateInitConfig(
  init: "all" | "firebase" | "sentry",
  deploymentDir: string,
  targetEnv: string,
  envList: string[],
  devSource: string | undefined,
): void {
  const missing: string[] = [];

  if (init === "firebase" || init === "all") {
    const activeTargets =
      targetEnv === "all" || targetEnv === "development"
        ? envList
        : [targetEnv];
    for (const envName of activeTargets)
      missing.push(...firebaseConfigMissing(deploymentDir, envName, envName));

    const includesDev = targetEnv === "all" || targetEnv === "development";
    if (includesDev && devSource)
      missing.push(
        ...firebaseConfigMissing(deploymentDir, devSource, "development"),
      );
  }

  if (init === "sentry" || init === "all") {
    const source = sentrySourceEnv(targetEnv, envList, devSource);
    if (!source) {
      missing.push(
        "Sentry: no preview/staging environment found — add staging to environments.yml",
      );
    } else {
      const envVars = parseDeploymentEnv(deploymentDir, source);
      if (!envVars.SENTRY_ORG && !process.env.SENTRY_ORG)
        missing.push(`SENTRY_ORG [${source}]: add to deployment YAML or shell`);
      if (!envVars.SENTRY_PROJECT && !process.env.SENTRY_PROJECT)
        missing.push(
          `SENTRY_PROJECT [${source}]: add to deployment YAML or shell`,
        );
    }
  }

  if (missing.length > 0)
    err(
      `secrets init ${init}: missing required configuration:\n${missing
        .map((m) => `  · ${m}`)
        .join("\n")}`,
    );
}

export { sentrySourceEnv };
