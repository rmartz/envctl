import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { resolveVercelToken } from "./auth";
import { deploymentDir } from "./commands/deployment-config";
import {
  resolveFirebaseCredential,
  type FirebaseCredentialSpec,
} from "./firebase-credential";
import {
  logGithubPlan,
  resolveGithubSecrets,
  withGithubSecretSync,
} from "./github-secrets";
import { githubAppConfigFor } from "./github-app";
import { log, warn } from "./logger";
import { parseManifest } from "./manifest";
import { posthogVarsFor } from "./posthog";
import { resolveProjectDeployment } from "./providers/registry";
import {
  serviceProviders,
  type ServiceActivation,
  type ServiceContext,
  type ServiceProvider,
  type ServiceRotation,
} from "./providers/service";
import { assertRotationGuards } from "./rotation-guards";
import { assertProviderAuth, checkVercelPrereqs } from "./rotation-preflight";
import { envTargetResolver } from "./targets";

// The provider targets a service is scoped to (#89), from its manifest
// `services[].environments` declaration mapped through the env→target model.
// Undefined ⇒ the service is unscoped and applies to every environment.
export function serviceScopeTargets(
  configDir: string,
  provider: string,
): string[] | undefined {
  const service = parseManifest(configDir).services.find(
    (s) => s.provider === provider,
  );
  if (!service?.environments) return undefined;
  const resolveTarget = envTargetResolver(configDir);
  return [...new Set(service.environments.map((e) => resolveTarget(e)))];
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RotationOptions {
  targetEnv: string;
  invalidateKeys: boolean;
  /** Project root for `.vercel/project.json` detection. Defaults to CWD. */
  workingDir?: string;
  /** Deployment config directory (for resolving the deployment provider). */
  deploymentDir?: string;
  init?: "all" | "firebase" | "sentry" | "posthog" | "github-app";
  /** SA email for --init firebase. Falls back to FIREBASE_SA_EMAIL env var. */
  firebaseSaEmail?: string;
  /** GCP project ID for --init firebase. Falls back to GCLOUD_PROJECT env var. */
  gcpProject?: string;
  /** Sentry org slug. Falls back to SENTRY_ORG env var. */
  sentryOrg?: string;
  /** Sentry project slug. Falls back to SENTRY_PROJECT env var. */
  sentryProject?: string;
  /**
   * Restrict a rotation to a single provider (mirrors `secrets init`'s
   * positional). Undefined rotates every provider present in the project.
   * Ignored for `init` flows, which scope via {@link RotationOptions.init}.
   */
  provider?: "firebase" | "sentry" | "posthog" | "github-app";
  /** Local path to the GitHub App private key PEM (`--private-key-file`). */
  githubAppPrivateKeyFile?: string;
  /**
   * The resolved Firebase credential contract (shape + var names) from the
   * manifest (#97/#98). Defaults to the provider default (split + default names)
   * when unset, so callers without a manifest keep today's behavior.
   */
  firebaseCredential?: FirebaseCredentialSpec;
}

// ─── Main orchestration ───────────────────────────────────────────────────────

export async function run(opts: RotationOptions): Promise<void> {
  const token = resolveVercelToken();
  checkVercelPrereqs(token);

  const workingDir = opts.workingDir ?? process.cwd();
  const configDir = opts.deploymentDir ?? deploymentDir(workingDir);
  // Values pushed to a target with a declared GitHub secret (#198) are
  // mirrored there at push time — before the redeploy and invalidation.
  const runTargets =
    opts.targetEnv === "all"
      ? ["production", "preview", "development"]
      : [opts.targetEnv];
  const githubTargets = resolveGithubSecrets(configDir).filter((t) =>
    runTargets.includes(t.target),
  );
  const deployment = withGithubSecretSync(
    resolveProjectDeployment(configDir, workingDir),
    githubTargets,
  );
  log(
    `Project: ${deployment.projectId}${deployment.teamId ? ` (team: ${deployment.teamId})` : ""}`,
  );

  const ctx: ServiceContext = {
    targetEnv: opts.targetEnv,
    deployment,
    tempDir: "",
    firebaseCredential: opts.firebaseCredential ?? resolveFirebaseCredential(),
    firebaseSaEmail: opts.firebaseSaEmail,
    gcpProject: opts.gcpProject,
    sentryOrg: opts.sentryOrg,
    sentryProject: opts.sentryProject,
    posthogVars: posthogVarsFor(configDir),
    githubApp: githubAppConfigFor(configDir, opts.githubAppPrivateKeyFile),
  };

  const allEnvs = await deployment.listEnvVars();
  // Scope key-existence checks to the specific Vercel target so that
  // successive per-env --init calls (e.g. preview then production) don't
  // see secrets created for an earlier target and falsely error.
  const scopedEnvs =
    opts.targetEnv === "all"
      ? allEnvs.envs
      : allEnvs.envs.filter((e) => e.target.includes(opts.targetEnv));
  const envKeys = scopedEnvs.map((e) => e.key);

  const providers = serviceProviders();
  const isPresent = (p: ServiceProvider): boolean =>
    p.presenceKeys(ctx).some((k) => envKeys.includes(k));
  // `init all` covers only the API-automatable providers; a manual-only one
  // (manualSteps) is reachable only by naming it, which the guard refuses, and
  // an explicit-init one (explicitInit) only by naming it.
  const willInit = (p: ServiceProvider): boolean =>
    (opts.init === "all" && !p.manualSteps && !p.explicitInit) ||
    opts.init === p.provider;
  const automatable = providers.filter((p) => !p.manualSteps);

  // Environment scoping (#89): the provider targets this run covers, and each
  // service's declared scope. A service whose scope does not intersect this
  // run's targets is skipped entirely (silently — not acted on); a service that
  // partially overlaps acts only on its in-scope targets (enforced per-target
  // inside init/rotate via `allowedTargets`).
  const scopeFor = (p: ServiceProvider): string[] | undefined =>
    serviceScopeTargets(configDir, p.provider);
  const inScope = (p: ServiceProvider): boolean => {
    const scope = scopeFor(p);
    return scope === undefined || scope.some((t) => runTargets.includes(t));
  };

  assertRotationGuards({
    providers,
    ctx,
    init: opts.init,
    provider: opts.provider,
    isPresent,
    willInit,
    inScope,
  });

  // Which providers this run acts on: for init, whichever `opts.init` selects;
  // for rotate, whichever are present and not excluded by a provider scope.
  const acting = automatable.filter(
    (p) =>
      inScope(p) &&
      (opts.init
        ? willInit(p)
        : isPresent(p) &&
          (opts.provider === undefined || opts.provider === p.provider)),
  );

  // Fail fast if a provider we would mint/push for is not authenticated, before
  // any key is created — so a rotation can never leave a partial state (#91).
  assertProviderAuth({
    firebase: acting.some((p) => p.authKey === "firebase"),
    sentry: acting.some((p) => p.authKey === "sentry"),
    github: acting.length > 0 && githubTargets.length > 0,
    githubApp: acting.some((p) => p.authKey === "github-app")
      ? ctx.githubApp
      : undefined,
    sentryOrg: opts.sentryOrg,
    sentryProject: opts.sentryProject,
  });
  logGithubPlan(githubTargets);

  log(
    `Target: ${opts.targetEnv} | ${opts.init ? "Initializing" : `Invalidate after redeployment: ${opts.invalidateKeys}`}`,
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rotate-keys-"));
  ctx.tempDir = tempDir;
  try {
    if (opts.init) {
      const activations: (ServiceActivation | void)[] = [];
      for (const p of acting)
        activations.push(await p.init({ ...ctx, allowedTargets: scopeFor(p) }));
      await deployment.triggerAndWaitRedeployments(opts.targetEnv);
      for (const activation of activations) await activation?.activate?.();
      log("Key initialization complete.");
    } else {
      const rotations: ServiceRotation[] = [];
      for (const p of acting)
        rotations.push(await p.rotate({ ...ctx, allowedTargets: scopeFor(p) }));

      await deployment.triggerAndWaitRedeployments(opts.targetEnv);
      for (const rotation of rotations) await rotation.activate?.();

      if (opts.invalidateKeys) {
        log("Invalidating old keys...");
        for (const rotation of rotations) await rotation.invalidate();
      } else {
        log("Skipping key invalidation (--no-invalidate)");
        for (const rotation of rotations)
          for (const message of rotation.retiredKeyWarnings()) warn(message);
      }

      log("Key rotation complete.");
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
