import * as fs from "fs";
import * as path from "path";

import { err } from "./logger";
import { deploymentView, parseManifest, soleDeployment } from "./manifest";

export interface ProjectConfig {
  projectId: string;
  teamId?: string;
}

// A place that can name the Vercel project besides the manifest pin: the
// VERCEL_* env vars or the `.vercel/project.json` link. `label` names it in a
// mismatch error.
export interface IdentitySource {
  label: string;
  projectId?: string;
  teamId?: string;
}

// The project the deployment dir's manifest pins (#208): the first deployment
// entry's `projectId`/`teamId`, when it is a vercel deployment that sets one.
export function projectPin(deploymentDir: string): ProjectConfig | undefined {
  const deployment = soleDeployment(parseManifest(deploymentDir));
  if (deployment?.provider !== "vercel" || !deployment.projectId)
    return undefined;
  return deployment.teamId
    ? { projectId: deployment.projectId, teamId: deployment.teamId }
    : { projectId: deployment.projectId };
}

// Why a deployment view must be pinned but isn't, or undefined (#213). With
// several deployments in one manifest, an unpinned one would fall back to the
// shared `.vercel` link or VERCEL_* vars — the same project as its siblings —
// so it is refused rather than guessed.
export function missingSharedPin(deploymentDir: string): string | undefined {
  const view = deploymentView(deploymentDir);
  if (!view || view.siblings === 0 || projectPin(deploymentDir))
    return undefined;
  return `Deployment '${view.deployment.name}' must pin its Vercel project (projectId, teamId) in ${view.root}/manifest.yml: the manifest declares other deployments, so the shared .vercel link or VERCEL_PROJECT_ID can't tell them apart.`;
}

// Why a pin can't be used: the first source naming a different project or
// team, or undefined when every source agrees (or names nothing). A pin and a
// link must never silently disagree, since the pin exists to keep one
// project's secrets out of another.
export function pinConflict(
  pin: ProjectConfig,
  sources: readonly IdentitySource[],
): string | undefined {
  for (const source of sources) {
    if (source.projectId && source.projectId !== pin.projectId)
      return `The manifest pins Vercel project ${pin.projectId}, but ${source.label} names ${source.projectId}. Unset it or fix the pin.`;
    if (pin.teamId && source.teamId && source.teamId !== pin.teamId)
      return `The manifest pins Vercel team ${pin.teamId}, but ${source.label} names ${source.teamId}. Unset it or fix the pin.`;
  }
  return undefined;
}

function readLinkedProject(workingDir: string): IdentitySource | undefined {
  const projectJsonPath = path.join(workingDir, ".vercel", "project.json");
  if (!fs.existsSync(projectJsonPath)) return undefined;
  const data = JSON.parse(fs.readFileSync(projectJsonPath, "utf-8")) as {
    projectId?: string;
    orgId?: string;
  };
  return {
    label: ".vercel/project.json",
    projectId: data.projectId,
    teamId: data.orgId,
  };
}

function resolvePinned(pin: ProjectConfig, workingDir: string): ProjectConfig {
  const env: IdentitySource = {
    label: "VERCEL_PROJECT_ID/VERCEL_TEAM_ID",
    projectId: process.env.VERCEL_PROJECT_ID || undefined,
    teamId: process.env.VERCEL_TEAM_ID || undefined,
  };
  const linked = readLinkedProject(workingDir);
  const sources = linked ? [env, linked] : [env];
  const conflict = pinConflict(pin, sources);
  if (conflict) return err(conflict);
  const teamId = pin.teamId ?? env.teamId ?? linked?.teamId;
  return teamId ? { projectId: pin.projectId, teamId } : pin;
}

// Resolve the Vercel project to act on. A manifest pin in `deploymentDir`
// wins and is cross-checked against the env vars and the link; without one,
// VERCEL_* env vars override `.vercel/project.json` as before.
export function detectProject(
  workingDir: string = process.cwd(),
  deploymentDir?: string,
): ProjectConfig {
  const pin = deploymentDir ? projectPin(deploymentDir) : undefined;
  if (pin) return resolvePinned(pin, workingDir);
  const unpinned = deploymentDir ? missingSharedPin(deploymentDir) : undefined;
  if (unpinned) return err(unpinned);

  // An empty var counts as unset, so it can't blank out the link's identity.
  const projectId = process.env.VERCEL_PROJECT_ID || undefined;
  const teamId = process.env.VERCEL_TEAM_ID || undefined;

  const linked = readLinkedProject(workingDir);
  if (linked) {
    return {
      projectId: projectId ?? linked.projectId ?? "",
      teamId: teamId ?? linked.teamId ?? undefined,
    };
  }

  if (!projectId) {
    return err(
      "Could not detect Vercel project ID. Set VERCEL_PROJECT_ID, pin projectId in the manifest, or run from a Vercel project directory.",
    );
  }

  return { projectId, teamId };
}
