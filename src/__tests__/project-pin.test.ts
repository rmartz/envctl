import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FatalError } from "../lib/logger";
import { parseManifest } from "../lib/manifest";
import {
  detectProject,
  pinConflict,
  projectPin,
  type ProjectConfig,
} from "../lib/project";
import { resolveProjectDeployment } from "../lib/providers/registry";

let workingDir: string;
let deployDir: string;

beforeEach(() => {
  workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-pin-"));
  deployDir = path.join(workingDir, "deployment");
  fs.mkdirSync(deployDir);
  vi.stubEnv("VERCEL_PROJECT_ID", "");
  vi.stubEnv("VERCEL_TEAM_ID", "");
});

afterEach(() => {
  fs.rmSync(workingDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function makePinnedManifest(pin: string[]): void {
  fs.writeFileSync(
    path.join(deployDir, "manifest.yml"),
    [
      "environments: [production]",
      "deployments:",
      "  - provider: vercel",
      ...pin.map((line) => `    ${line}`),
      "    targets: { production: production }",
      "",
    ].join("\n"),
  );
}

function makeLink(projectId: string, orgId: string): void {
  fs.mkdirSync(path.join(workingDir, ".vercel"));
  fs.writeFileSync(
    path.join(workingDir, ".vercel", "project.json"),
    JSON.stringify({ projectId, orgId }),
  );
}

describe("manifest deployment pin parsing", () => {
  it("parses projectId and teamId onto the deployment entry", () => {
    makePinnedManifest(["projectId: prj_pinned", "teamId: team_pinned"]);
    expect(parseManifest(deployDir).deployments[0]).toMatchObject({
      projectId: "prj_pinned",
      teamId: "team_pinned",
    });
  });

  it("leaves projectId unset when the entry has no pin", () => {
    makePinnedManifest([]);
    expect(parseManifest(deployDir).deployments[0]?.projectId).toBeUndefined();
  });
});

describe("projectPin", () => {
  it("returns the pinned project and team", () => {
    makePinnedManifest(["projectId: prj_pinned", "teamId: team_pinned"]);
    expect(projectPin(deployDir)).toEqual({
      projectId: "prj_pinned",
      teamId: "team_pinned",
    });
  });

  it("ignores a teamId without a projectId", () => {
    makePinnedManifest(["teamId: team_pinned"]);
    expect(projectPin(deployDir)).toBeUndefined();
  });

  it("returns undefined for a legacy config with no manifest", () => {
    fs.writeFileSync(
      path.join(deployDir, "environments.yml"),
      "active:\n  - production\n",
    );
    expect(projectPin(deployDir)).toBeUndefined();
  });
});

describe("pinConflict", () => {
  const pin: ProjectConfig = { projectId: "prj_a", teamId: "team_a" };

  it("accepts sources that name the pinned project and team", () => {
    expect(
      pinConflict(pin, [
        { label: "env", projectId: "prj_a", teamId: "team_a" },
      ]),
    ).toBeUndefined();
  });

  it("accepts sources that name nothing", () => {
    expect(pinConflict(pin, [{ label: "env" }])).toBeUndefined();
  });

  it("names the source and both projects on a project mismatch", () => {
    expect(pinConflict(pin, [{ label: "the link", projectId: "prj_b" }])).toBe(
      "The manifest pins Vercel project prj_a, but the link names prj_b. Unset it or fix the pin.",
    );
  });

  it("reports a team mismatch when the pin sets a team", () => {
    expect(
      pinConflict(pin, [
        { label: "env", projectId: "prj_a", teamId: "team_b" },
      ]),
    ).toMatch(/pins Vercel team team_a, but env names team_b/);
  });

  it("ignores a source's team when the pin sets none", () => {
    expect(
      pinConflict({ projectId: "prj_a" }, [
        { label: "env", projectId: "prj_a", teamId: "team_b" },
      ]),
    ).toBeUndefined();
  });
});

describe("detectProject with a pin", () => {
  it("resolves the pin when nothing else names a project", () => {
    makePinnedManifest(["projectId: prj_pinned", "teamId: team_pinned"]);
    expect(detectProject(workingDir, deployDir)).toEqual({
      projectId: "prj_pinned",
      teamId: "team_pinned",
    });
  });

  it("accepts a .vercel link naming the same project", () => {
    makePinnedManifest(["projectId: prj_pinned"]);
    makeLink("prj_pinned", "team_linked");
    expect(detectProject(workingDir, deployDir)).toEqual({
      projectId: "prj_pinned",
      teamId: "team_linked",
    });
  });

  it("refuses a .vercel link naming a different project", () => {
    makePinnedManifest(["projectId: prj_pinned"]);
    makeLink("prj_other", "team_linked");
    expect(() => detectProject(workingDir, deployDir)).toThrow(
      /\.vercel\/project\.json names prj_other/,
    );
  });

  it("refuses VERCEL_PROJECT_ID naming a different project", () => {
    makePinnedManifest(["projectId: prj_pinned"]);
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_other");
    expect(() => detectProject(workingDir, deployDir)).toThrow(FatalError);
  });

  it("refuses VERCEL_TEAM_ID naming a different pinned team", () => {
    makePinnedManifest(["projectId: prj_pinned", "teamId: team_pinned"]);
    vi.stubEnv("VERCEL_TEAM_ID", "team_other");
    expect(() => detectProject(workingDir, deployDir)).toThrow(
      /pins Vercel team team_pinned/,
    );
  });

  it("takes the team from VERCEL_TEAM_ID when the pin sets none", () => {
    makePinnedManifest(["projectId: prj_pinned"]);
    vi.stubEnv("VERCEL_TEAM_ID", "team_env");
    expect(detectProject(workingDir, deployDir).teamId).toBe("team_env");
  });
});

describe("detectProject without a pin", () => {
  it("lets VERCEL_PROJECT_ID override the .vercel link, as before", () => {
    makePinnedManifest([]);
    makeLink("prj_linked", "team_linked");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_env");
    expect(detectProject(workingDir, deployDir).projectId).toBe("prj_env");
  });

  it("ignores the manifest when no deployment dir is passed", () => {
    makePinnedManifest(["projectId: prj_pinned"]);
    makeLink("prj_linked", "team_linked");
    expect(detectProject(workingDir).projectId).toBe("prj_linked");
  });
});

describe("resolveProjectDeployment with a pin", () => {
  it("builds the vercel provider against the pinned project", () => {
    vi.stubEnv("VERCEL_TOKEN", "test-token");
    makePinnedManifest(["projectId: prj_pinned", "teamId: team_pinned"]);
    const deployment = resolveProjectDeployment(deployDir, workingDir);
    expect([deployment.projectId, deployment.teamId]).toEqual([
      "prj_pinned",
      "team_pinned",
    ]);
  });
});
