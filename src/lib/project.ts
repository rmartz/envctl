import * as fs from "fs";
import * as path from "path";

import { err } from "./logger";

export interface ProjectConfig {
  projectId: string;
  teamId?: string;
}

export function detectProject(): ProjectConfig {
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId = process.env.VERCEL_TEAM_ID ?? undefined;

  const projectJsonPath = path.join(process.cwd(), ".vercel", "project.json");
  if (fs.existsSync(projectJsonPath)) {
    const data = JSON.parse(fs.readFileSync(projectJsonPath, "utf-8")) as {
      projectId?: string;
      orgId?: string;
    };
    return {
      projectId: projectId ?? data.projectId ?? "",
      teamId: teamId ?? data.orgId ?? undefined,
    };
  }

  if (!projectId) {
    return err(
      "Could not detect Vercel project ID. Set VERCEL_PROJECT_ID or run from a Vercel project directory.",
    );
  }

  return { projectId, teamId };
}
