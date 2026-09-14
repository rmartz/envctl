import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FatalError } from "../../lib/logger";
import {
  resolveDeploymentProvider,
  resolveProjectDeployment,
} from "../../lib/providers/registry";

describe("deployment provider registry", () => {
  let workingDir: string;
  let deployDir: string;
  let origEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-test-"));
    deployDir = path.join(workingDir, "deployment");
    fs.mkdirSync(deployDir);
    origEnv = { ...process.env };
    // Identity the vercel provider resolves at construction.
    process.env.VERCEL_TOKEN = "test-token";
    process.env.VERCEL_PROJECT_ID = "prj_test";
    delete process.env.VERCEL_TEAM_ID;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = origEnv;
    fs.rmSync(workingDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const write = (name: string, content: string): void =>
    fs.writeFileSync(path.join(deployDir, name), content);

  describe("resolveDeploymentProvider", () => {
    it("resolves the vercel provider with the detected project identity", () => {
      const provider = resolveDeploymentProvider("vercel", workingDir);
      expect(provider.provider).toBe("vercel");
      expect(provider.projectId).toBe("prj_test");
    });

    it("errors, naming the offending value, for an unknown provider", () => {
      expect(() => resolveDeploymentProvider("netlify", workingDir)).toThrow(
        FatalError,
      );
      expect(() => resolveDeploymentProvider("netlify", workingDir)).toThrow(
        /netlify/,
      );
    });
  });

  describe("resolveProjectDeployment", () => {
    it("uses the manifest's declared deployment provider", () => {
      write(
        "manifest.yml",
        [
          "environments: [production]",
          "deployments:",
          "  - provider: vercel",
          "    targets: { production: production }",
        ].join("\n") + "\n",
      );
      expect(resolveProjectDeployment(deployDir, workingDir).provider).toBe(
        "vercel",
      );
    });

    it("defaults to vercel for a legacy config with no manifest", () => {
      write("environments.yml", "active:\n  - production\n");
      expect(resolveProjectDeployment(deployDir, workingDir).provider).toBe(
        "vercel",
      );
    });

    it("errors for a manifest declaring an unregistered provider", () => {
      write(
        "manifest.yml",
        [
          "environments: [production]",
          "deployments:",
          "  - provider: cloudflare",
          "    targets: { production: production }",
        ].join("\n") + "\n",
      );
      expect(() => resolveProjectDeployment(deployDir, workingDir)).toThrow(
        /cloudflare/,
      );
    });
  });
});
