import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { envTargetResolver, resolveEnvTarget } from "../lib/targets";

describe("resolveEnvTarget", () => {
  let deployDir: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "targets-test-"));
    deployDir = path.join(tmpDir, "deployment");
    fs.mkdirSync(deployDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const write = (name: string, content: string): void =>
    fs.writeFileSync(path.join(deployDir, name), content);

  describe("the manifest targets map is authoritative (AC1)", () => {
    it("resolves an env to its declared target even when it differs from the name convention", () => {
      write(
        "manifest.yml",
        [
          "environments: [production, demo]",
          "deployments:",
          "  - provider: vercel",
          "    targets: { production: production, demo: preview }",
        ].join("\n") + "\n",
      );
      // The name convention would map "demo" to itself; the manifest wins.
      expect(resolveEnvTarget(deployDir, "demo")).toBe("preview");
      expect(resolveEnvTarget(deployDir, "production")).toBe("production");
    });

    it("maps two non-conventionally-named preview-tier envs both to preview", () => {
      write(
        "manifest.yml",
        [
          "environments: [edge, canary]",
          "deployments:",
          "  - provider: vercel",
          "    targets: { edge: preview, canary: preview }",
        ].join("\n") + "\n",
      );
      const resolve = envTargetResolver(deployDir);
      expect(resolve("edge")).toBe("preview");
      expect(resolve("canary")).toBe("preview");
    });
  });

  describe("name-convention fallback (AC2)", () => {
    it("falls back to the convention when no manifest declares targets", () => {
      write("environments.yml", "active:\n  - production\n  - staging\n");
      expect(resolveEnvTarget(deployDir, "staging")).toBe("preview");
      expect(resolveEnvTarget(deployDir, "production")).toBe("production");
    });

    it("falls back for an env omitted from the manifest targets map", () => {
      write(
        "manifest.yml",
        [
          "environments: [production, staging]",
          "deployments:",
          "  - provider: vercel",
          "    targets: { production: production }",
        ].join("\n") + "\n",
      );
      expect(resolveEnvTarget(deployDir, "staging")).toBe("preview");
    });
  });
});
