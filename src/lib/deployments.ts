import { log, warn } from "./logger";
import type { VercelClient } from "./vercel-api";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function targetEnvs(targetEnv: string): string[] {
  if (targetEnv === "all") return ["production", "preview", "development"];
  return [targetEnv];
}

// Poll one redeployment and report its outcome. A `canceled` result is benign
// (#125): Vercel auto-cancels a redeploy when a newer build supersedes it, so
// verification simply didn't complete on this deployment — the pushed variables
// are already saved on the target and take effect on its next successful build.
// It is a warning, not a failure; only a genuine ERROR/timeout throws (from
// pollDeploymentStatus).
async function pollAndReport(
  client: VercelClient,
  id: string,
): Promise<"ready" | "canceled"> {
  log(`  Polling ${id}...`);
  const status = await client.pollDeploymentStatus(id, 60, 10_000);
  if (status === "canceled") {
    warn(
      `  ${id} → CANCELED (superseded by a newer build or auto-canceled). The pushed variables are saved on the target and apply on its next successful build; verification did not complete for this deployment.`,
    );
  } else {
    log(`  ${id} → READY`);
  }
  return status;
}

// ─── Redeployment ─────────────────────────────────────────────────────────────

export async function triggerAndWaitRedeployments(
  targetEnv: string,
  client: VercelClient,
): Promise<void> {
  log("Triggering redeployments...");

  const deploymentIds: string[] = [];

  for (const vercelEnv of targetEnvs(targetEnv)) {
    if (vercelEnv === "development") {
      log(`  [${vercelEnv}] No remote deployment target — skipping`);
      continue;
    }
    const deployTarget = vercelEnv === "production" ? "production" : "staging";
    const latest = await client.getLatestDeployment(deployTarget);
    if (!latest) {
      warn(
        `No READY deployment found for '${vercelEnv}' — skipping redeployment`,
      );
      continue;
    }
    log(`  Redeploying ${vercelEnv} (${latest.url})...`);
    const newId = await client.triggerRedeployment(
      latest.uid,
      latest.name,
      deployTarget,
    );
    deploymentIds.push(newId);
    log(`  Queued: ${newId}`);
  }

  if (deploymentIds.length === 0) return;
  log(`Waiting for ${deploymentIds.length} deployment(s) to finish...`);

  let allReady = true;
  for (const id of deploymentIds) {
    if ((await pollAndReport(client, id)) === "canceled") allReady = false;
  }
  log(allReady ? "All deployments ready." : "Redeployment polling complete.");
}

export async function refreshPreviewDeployments(
  client: VercelClient,
): Promise<void> {
  const previews = await client.listPreviewDeployments();
  if (previews.length === 0) {
    log("No active preview deployments found — skipping preview refresh.");
    return;
  }
  log(`Refreshing ${previews.length} active preview deployment(s)...`);

  const newIds: string[] = [];
  for (const preview of previews) {
    log(`  Redeploying ${preview.url}...`);
    const newId = await client.triggerRedeployment(preview.uid, preview.name);
    newIds.push(newId);
    log(`  Queued: ${newId}`);
  }

  log(`Waiting for ${newIds.length} preview deployment(s) to finish...`);
  let allReady = true;
  for (const id of newIds) {
    if ((await pollAndReport(client, id)) === "canceled") allReady = false;
  }
  log(
    allReady
      ? "Preview deployments refreshed."
      : "Preview redeployment polling complete.",
  );
}
