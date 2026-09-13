import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { resolveVercelToken } from "./auth";
import { err, log, warn } from "./logger";
import { detectProject } from "./project";
import { assertProviderAuth, checkVercelPrereqs } from "./rotation-preflight";
import { VercelClient } from "./vercel-api";
import type { FirebasePattern, OldFirebaseKey } from "./firebase";
import {
  invalidateFirebaseKeys,
  initFirebase,
  rotateFirebase as rotateFirebaseKeys,
} from "./firebase";
import {
  firebasePresenceKeys,
  resolveFirebaseCredential,
  type FirebaseCredentialSpec,
} from "./firebase-credential";
import {
  initSentry,
  invalidateSentryKey,
  rotateSentry as rotateSentryKey,
} from "./sentry";
import { triggerAndWaitRedeployments } from "./deployments";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RotationOptions {
  targetEnv: string;
  invalidateKeys: boolean;
  /** Project root for `.vercel/project.json` detection. Defaults to CWD. */
  workingDir?: string;
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
   * manifest (#97/#98). Defaults to the provider default (json + default names)
   * when unset, so callers without a manifest keep today's behavior.
   */
  firebaseCredential?: FirebaseCredentialSpec;
}

// ─── Main orchestration ───────────────────────────────────────────────────────

export async function run(opts: RotationOptions): Promise<void> {
  const token = resolveVercelToken();
  checkVercelPrereqs(token);

  const project = detectProject(opts.workingDir);
  log(
    `Project: ${project.projectId}${project.teamId ? ` (team: ${project.teamId})` : ""}`,
  );

  const client = new VercelClient(token, project.projectId, project.teamId);

  const firebaseSpec = opts.firebaseCredential ?? resolveFirebaseCredential();
  const firebaseKeys = firebasePresenceKeys(firebaseSpec);

  const allEnvs = await client.listEnvVars();
  // Scope key-existence checks to the specific Vercel target so that
  // successive per-env --init calls (e.g. preview then production) don't
  // see secrets created for an earlier target and falsely error.
  const scopedEnvs =
    opts.targetEnv === "all"
      ? allEnvs.envs
      : allEnvs.envs.filter((e) => e.target.includes(opts.targetEnv));
  const envKeys = scopedEnvs.map((e) => e.key);

  const hasFirebase = envKeys.some((k) => firebaseKeys.includes(k));
  const hasSentry = envKeys.some((k) =>
    ["SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN"].includes(k),
  );

  // Which providers this run will actually act on. For rotate, `opts.provider`
  // scopes to a single present provider; unset rotates every present one. For
  // init, `opts.init` selects the provider(s).
  const rotateFirebase = hasFirebase && opts.provider !== "sentry";
  const rotateSentry = hasSentry && opts.provider !== "firebase";
  const willInitFirebase = opts.init === "all" || opts.init === "firebase";
  const willInitSentry = opts.init === "all" || opts.init === "sentry";

  if (opts.init) {
    if (willInitFirebase && hasFirebase) {
      err(
        "Firebase keys already exist in this Vercel project — use `envctl secrets rotate` to update them, not `envctl secrets init`.",
      );
    }
    if (willInitSentry && hasSentry) {
      err(
        "Sentry keys already exist in this Vercel project — use `envctl secrets rotate` to update them, not `envctl secrets init`.",
      );
    }
  } else if (opts.provider === "firebase" && !hasFirebase) {
    err(
      "No Firebase keys found in this Vercel project — nothing to rotate for `firebase`. To push them for the first time, use `envctl secrets init firebase`.",
    );
  } else if (opts.provider === "sentry" && !hasSentry) {
    err(
      "No Sentry keys found in this Vercel project — nothing to rotate for `sentry`. To push them for the first time, use `envctl secrets init sentry`.",
    );
  } else if (!hasFirebase && !hasSentry) {
    err(
      "No Firebase or Sentry keys found in this Vercel project — nothing to rotate. To push secrets for the first time, use `envctl secrets init`.",
    );
  }

  // Fail fast if a provider we would mint/push for is not authenticated, before
  // any key is created — so a rotation can never leave a partial state (#91).
  assertProviderAuth(
    opts.init
      ? {
          firebase: willInitFirebase,
          sentry: willInitSentry,
          sentryOrg: opts.sentryOrg,
          sentryProject: opts.sentryProject,
        }
      : {
          firebase: rotateFirebase,
          sentry: rotateSentry,
          sentryOrg: opts.sentryOrg,
          sentryProject: opts.sentryProject,
        },
  );

  log(
    `Target: ${opts.targetEnv} | ${opts.init ? "Initializing" : `Invalidate after redeployment: ${opts.invalidateKeys}`}`,
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rotate-keys-"));
  try {
    if (opts.init) {
      if (opts.init === "all" || opts.init === "firebase") {
        await initFirebase(
          opts.targetEnv,
          client,
          tempDir,
          opts.firebaseSaEmail,
          opts.gcpProject,
          firebaseSpec,
        );
      }
      if (opts.init === "all" || opts.init === "sentry") {
        await initSentry(
          opts.targetEnv,
          client,
          opts.sentryOrg,
          opts.sentryProject,
        );
      }
      await triggerAndWaitRedeployments(opts.targetEnv, client);
      log("Key initialization complete.");
    } else {
      let oldFirebaseKeys: OldFirebaseKey[] = [];
      let fp: FirebasePattern | null = null;
      let oldSentryKeyId = "";

      if (rotateFirebase) {
        ({ oldKeys: oldFirebaseKeys, fp } = await rotateFirebaseKeys(
          opts.targetEnv,
          client,
          tempDir,
          firebaseSpec,
        ));
      }
      if (rotateSentry) {
        oldSentryKeyId = await rotateSentryKey(
          opts.targetEnv,
          client,
          opts.sentryOrg,
          opts.sentryProject,
        );
      }

      await triggerAndWaitRedeployments(opts.targetEnv, client);

      if (opts.invalidateKeys) {
        log("Invalidating old keys...");
        if (rotateFirebase && fp) await invalidateFirebaseKeys(client, fp);
        if (rotateSentry && oldSentryKeyId) {
          const org = opts.sentryOrg ?? process.env.SENTRY_ORG;
          const project = opts.sentryProject ?? process.env.SENTRY_PROJECT;
          if (!org || !project)
            return err(
              "SENTRY_ORG and SENTRY_PROJECT are required for key invalidation",
            );
          await invalidateSentryKey(oldSentryKeyId, org, project);
        }
      } else {
        log("Skipping key invalidation (--no-invalidate)");
        for (const { vercelEnv, keyId, saEmail } of oldFirebaseKeys) {
          warn(
            `Old Firebase key to remove: ${keyId} (${vercelEnv}, account: ${saEmail})`,
          );
        }
        if (oldSentryKeyId) {
          const org = opts.sentryOrg ?? process.env.SENTRY_ORG;
          const project = opts.sentryProject ?? process.env.SENTRY_PROJECT;
          warn(
            `Old Sentry key to remove: ${oldSentryKeyId} (project: ${org}/${project})`,
          );
        }
      }

      log("Key rotation complete.");
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
