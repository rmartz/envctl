import { parseDeploymentEnv } from "../environments";
import { GITHUB_APP_PROVIDER } from "../github-app";
import { err, log } from "../logger";
import { parseManifest } from "../manifest";

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

// Scans the deployment config's public vars to determine which secret-backed
// services a project uses. Shared by `--init auto` resolution and `bootstrap`.
// A GitHub App has no telltale public var, so it counts as configured only when
// the manifest declares a `github-app` service (#201).
export function detectConfiguredServices(
  deploymentDir: string,
  targetEnv: string,
  envList: string[],
  devSource: string | undefined,
): { firebase: boolean; sentry: boolean; githubApp: boolean } {
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
  const manifest = parseManifest(deploymentDir);
  const declares = (provider: string): boolean =>
    manifest.services.some((s) => s.provider === provider);
  // A deployment that lists its services gets only those (#213): public vars
  // in a shared overlay must not pull in a service it didn't list.
  const listsServices = manifest.deployments[0]?.services !== undefined;
  const allowed = (provider: string): boolean =>
    !listsServices || declares(provider);

  return {
    firebase:
      allowed("firebase") &&
      keys.some((k) =>
        [
          "FIREBASE_PROJECT_ID",
          "FIREBASE_SA_EMAIL",
          "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
        ].includes(k),
      ),
    sentry:
      allowed("sentry") &&
      keys.some((k) => ["SENTRY_ORG", "SENTRY_PROJECT"].includes(k)),
    githubApp: declares(GITHUB_APP_PROVIDER),
  };
}

// Resolves `--init auto` by scanning the deployment config for public vars that
// indicate which services are in use. Errors if none is configured, or if a
// GitHub App is configured alongside Firebase/Sentry (`init all` means Firebase +
// Sentry, so each must then be named).
export function resolveAutoInit(
  deploymentDir: string,
  targetEnv: string,
  envList: string[],
  devSource: string | undefined,
): "all" | "firebase" | "sentry" | "github-app" {
  const {
    firebase: hasFirebase,
    sentry: hasSentry,
    githubApp: hasGithubApp,
  } = detectConfiguredServices(deploymentDir, targetEnv, envList, devSource);

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

  log(
    hasGithubApp
      ? "  GitHub App: initialize (github-app service declared)"
      : "  GitHub App: skip (no github-app service in manifest.yml)",
  );

  if (!hasFirebase && !hasSentry && !hasGithubApp)
    err(
      "secrets init: nothing to initialize — no Firebase or Sentry public config vars or github-app service found in the deployment config",
    );
  if (hasGithubApp && (hasFirebase || hasSentry))
    err(
      "secrets init: both a github-app service and Firebase/Sentry are configured — initialize each by name: `envctl secrets init github-app --private-key-file <pem>`, then `envctl secrets init firebase|sentry|all`",
    );
  if (hasGithubApp) return "github-app";

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
  // Both identity vars are statically required (#143): #127 made init resolve the
  // service account strictly from the target's own declared FIREBASE_SA_EMAIL —
  // never a sibling credential — so its absence must be reported up front here,
  // alongside FIREBASE_PROJECT_ID, rather than surfacing as a mid-run error.
  // (Automatic SA discovery that would retire this input is gated on #70.)
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
  init: "all" | "firebase" | "sentry" | "posthog" | "github-app",
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

// Refuses a named provider that the deployment doesn't list among its services
// (#213), so `secrets init sentry --deployment gate` can't put a Sentry token
// into a project whose manifest entry left Sentry out. A deployment with no
// `services` list gets every service, as before.
export function assertServiceListed(
  deploymentDir: string,
  provider: string,
): void {
  const manifest = parseManifest(deploymentDir);
  const deployment = manifest.deployments[0];
  if (deployment?.services === undefined) return;
  if (manifest.services.some((s) => s.provider === provider)) return;
  err(
    `Deployment '${deployment.name}' doesn't list a ${provider} service (services: ${deployment.services.join(", ") || "none"}). Add it to the deployment's services to manage it there.`,
  );
}

export { sentrySourceEnv };
