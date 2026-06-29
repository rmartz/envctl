import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { resolveVercelToken } from "./auth";
import { err, log, warn } from "./logger";
import { detectProject } from "./project";
import { commandExists, run as runCmd } from "./subprocess";
import { VercelClient } from "./vercel-api";
import {
  FirebasePattern,
  OldFirebaseKey,
  invalidateFirebaseKeys,
  initFirebase,
  rotateFirebase,
} from "./firebase";
import { initSentry, invalidateSentryKey, rotateSentry } from "./sentry";
import { triggerAndWaitRedeployments } from "./deployments";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RotationOptions {
  targetEnv: string;
  invalidateKeys: boolean;
  init?: "all" | "firebase" | "sentry";
  /** SA email for --init firebase. Falls back to FIREBASE_SA_EMAIL env var. */
  firebaseSaEmail?: string;
  /** GCP project ID for --init firebase. Falls back to GCLOUD_PROJECT env var. */
  gcpProject?: string;
  /** Sentry org slug. Falls back to SENTRY_ORG env var. */
  sentryOrg?: string;
  /** Sentry project slug. Falls back to SENTRY_PROJECT env var. */
  sentryProject?: string;
}

// ─── Prerequisites ────────────────────────────────────────────────────────────

function checkPrereqs(
  needsGcloud: boolean,
  token: string | undefined,
): asserts token is string {
  const missing: string[] = [];
  if (!commandExists("vercel")) missing.push("vercel");
  if (needsGcloud && !commandExists("gcloud")) missing.push("gcloud");
  if (missing.length > 0) err(`Missing required tools: ${missing.join(" ")}`);

  if (!token)
    err(
      "No Vercel token found. Set VERCEL_TOKEN or run 'vercel login' to authenticate.",
    );

  try {
    runCmd("vercel", ["whoami"]);
  } catch {
    err("Vercel CLI not authenticated. Run: vercel login");
  }
}

// ─── Main orchestration ───────────────────────────────────────────────────────

export async function run(opts: RotationOptions): Promise<void> {
  // gcloud is only needed for Firebase-related flows.
  // When opts.init is undefined we don't yet know hasFirebase, so we conservatively
  // require gcloud unless we know this is a Sentry-only init.
  const needsGcloud = opts.init !== "sentry";
  const token = resolveVercelToken();
  checkPrereqs(needsGcloud, token);

  const project = detectProject();
  log(
    `Project: ${project.projectId}${project.teamId ? ` (team: ${project.teamId})` : ""}`,
  );

  const client = new VercelClient(token, project.projectId, project.teamId);

  const allEnvs = await client.listEnvVars();
  // Scope key-existence checks to the specific Vercel target so that
  // successive per-env --init calls (e.g. preview then production) don't
  // see secrets created for an earlier target and falsely error.
  const scopedEnvs =
    opts.targetEnv === "all"
      ? allEnvs.envs
      : allEnvs.envs.filter((e) => e.target.includes(opts.targetEnv));
  const envKeys = scopedEnvs.map((e) => e.key);

  const hasFirebase = envKeys.some((k) =>
    ["FIREBASE_SERVICE_ACCOUNT", "FIREBASE_PRIVATE_KEY"].includes(k),
  );
  const hasSentry = envKeys.some((k) =>
    ["SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN"].includes(k),
  );

  if (opts.init) {
    if ((opts.init === "all" || opts.init === "firebase") && hasFirebase) {
      err(
        "Firebase keys already exist in this Vercel project — use sync-env --rotate-keys to update them, not --init.",
      );
    }
    if ((opts.init === "all" || opts.init === "sentry") && hasSentry) {
      err(
        "Sentry keys already exist in this Vercel project — use sync-env --rotate-keys to update them, not --init.",
      );
    }
  } else if (!hasFirebase && !hasSentry) {
    err(
      "No Firebase or Sentry keys found in this Vercel project — nothing to rotate. To push secrets for the first time, use --init.",
    );
  }

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

      if (hasFirebase) {
        ({ oldKeys: oldFirebaseKeys, fp } = await rotateFirebase(
          opts.targetEnv,
          client,
          tempDir,
        ));
      }
      if (hasSentry) {
        oldSentryKeyId = await rotateSentry(
          opts.targetEnv,
          client,
          opts.sentryOrg,
          opts.sentryProject,
        );
      }

      await triggerAndWaitRedeployments(opts.targetEnv, client);

      if (opts.invalidateKeys) {
        log("Invalidating old keys...");
        if (hasFirebase && fp) await invalidateFirebaseKeys(client, fp);
        if (hasSentry && oldSentryKeyId) {
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
