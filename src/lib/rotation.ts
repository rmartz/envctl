import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { resolveVercelToken } from "./auth";
import { deploymentDir } from "./commands/deployment-config";
import {
  resolveFirebaseCredential,
  type FirebaseCredentialSpec,
} from "./firebase-credential";
import { err, log, warn } from "./logger";
import { resolveProjectDeployment } from "./providers/registry";
import {
  resolveServiceProvider,
  serviceProviders,
  type ServiceContext,
  type ServiceProvider,
  type ServiceRotation,
} from "./providers/service";
import { assertProviderAuth, checkVercelPrereqs } from "./rotation-preflight";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RotationOptions {
  targetEnv: string;
  invalidateKeys: boolean;
  /** Project root for `.vercel/project.json` detection. Defaults to CWD. */
  workingDir?: string;
  /** Deployment config directory (for resolving the deployment provider). */
  deploymentDir?: string;
  init?: "all" | "firebase" | "sentry";
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
  provider?: "firebase" | "sentry";
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
  const deployment = resolveProjectDeployment(
    opts.deploymentDir ?? deploymentDir(workingDir),
    workingDir,
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
  const willInit = (p: ServiceProvider): boolean =>
    opts.init === "all" || opts.init === p.provider;

  // Guards, iterating the registry rather than naming providers:
  //  - init: erroring if a selected provider's secret already exists
  //  - scoped rotate: erroring if the named provider is absent
  //  - unscoped rotate: erroring if nothing is present to rotate
  if (opts.init) {
    for (const p of providers) {
      if (willInit(p) && isPresent(p))
        err(
          `${p.displayName} keys already exist in this Vercel project — use \`envctl secrets rotate\` to update them, not \`envctl secrets init\`.`,
        );
    }
  } else if (opts.provider) {
    const scoped = resolveServiceProvider(opts.provider);
    if (!isPresent(scoped))
      err(
        `No ${scoped.displayName} keys found in this Vercel project — nothing to rotate for \`${opts.provider}\`. To push them for the first time, use \`envctl secrets init ${opts.provider}\`.`,
      );
  } else if (!providers.some(isPresent)) {
    err(
      `No ${providers.map((p) => p.displayName).join(" or ")} keys found in this Vercel project — nothing to rotate. To push secrets for the first time, use \`envctl secrets init\`.`,
    );
  }

  // Which providers this run acts on: for init, whichever `opts.init` selects;
  // for rotate, whichever are present and not excluded by a provider scope.
  const acting = providers.filter((p) =>
    opts.init
      ? willInit(p)
      : isPresent(p) &&
        (opts.provider === undefined || opts.provider === p.provider),
  );

  // Fail fast if a provider we would mint/push for is not authenticated, before
  // any key is created — so a rotation can never leave a partial state (#91).
  assertProviderAuth({
    firebase: acting.some((p) => p.authKey === "firebase"),
    sentry: acting.some((p) => p.authKey === "sentry"),
    sentryOrg: opts.sentryOrg,
    sentryProject: opts.sentryProject,
  });

  log(
    `Target: ${opts.targetEnv} | ${opts.init ? "Initializing" : `Invalidate after redeployment: ${opts.invalidateKeys}`}`,
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rotate-keys-"));
  ctx.tempDir = tempDir;
  try {
    if (opts.init) {
      for (const p of acting) await p.init(ctx);
      await deployment.triggerAndWaitRedeployments(opts.targetEnv);
      log("Key initialization complete.");
    } else {
      const rotations: ServiceRotation[] = [];
      for (const p of acting) rotations.push(await p.rotate(ctx));

      await deployment.triggerAndWaitRedeployments(opts.targetEnv);

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
