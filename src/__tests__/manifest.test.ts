import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  effectiveValue,
  parseManifest,
  variableVisibility,
} from "../lib/manifest";

describe("manifest", () => {
  let deployDir: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-test-"));
    deployDir = path.join(tmpDir, "deployment");
    fs.mkdirSync(deployDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(name: string, content: string): void {
    fs.writeFileSync(path.join(deployDir, name), content);
  }

  describe("parseManifest — new manifest.yml", () => {
    beforeEach(() => {
      write(
        "manifest.yml",
        [
          "environments: [production, staging, qa]",
          "deployments:",
          "  - provider: vercel",
          "    targets: { production: production, staging: preview, qa: preview }",
          "services:",
          "  - provider: firebase",
          "  - provider: action-tracking",
          "    environments: [production]",
          "variables:",
          '  NEXT_PUBLIC_SITE_NAME: { value: "Hidden Role Game" }',
          "  CRON_SECRET: { generate: true }",
          "variableGroups:",
          "  - name: prod-analytics",
          "    environments: [production]",
          "    variables:",
          "      ANALYTICS_WRITE_KEY: { generate: true }",
        ].join("\n") + "\n",
      );
    });

    it("parses the environment list", () => {
      expect(parseManifest(deployDir).environments).toEqual([
        "production",
        "staging",
        "qa",
      ]);
    });

    it("parses a deployment's explicit env→target map", () => {
      expect(parseManifest(deployDir).deployments).toEqual([
        {
          provider: "vercel",
          targets: {
            production: "production",
            staging: "preview",
            qa: "preview",
          },
        },
      ]);
    });

    it("parses services, carrying an environment scope when declared", () => {
      expect(parseManifest(deployDir).services).toEqual([
        { provider: "firebase" },
        { provider: "action-tracking", environments: ["production"] },
      ]);
    });

    it("parses a service's field→var-name map", () => {
      write(
        "manifest.yml",
        [
          "environments: [production]",
          "services:",
          "  - provider: firebase",
          "    variables:",
          "      privateKey: FB_PRIVATE_KEY",
          "      clientEmail: FB_CLIENT_EMAIL",
        ].join("\n") + "\n",
      );
      expect(parseManifest(deployDir).services).toEqual([
        {
          provider: "firebase",
          variables: {
            privateKey: "FB_PRIVATE_KEY",
            clientEmail: "FB_CLIENT_EMAIL",
          },
        },
      ]);
    });

    it("parses top-level variables with their source discriminant", () => {
      expect(parseManifest(deployDir).variables).toEqual([
        {
          name: "NEXT_PUBLIC_SITE_NAME",
          source: { kind: "value", value: "Hidden Role Game" },
        },
        { name: "CRON_SECRET", source: { kind: "generate" } },
      ]);
    });

    it("parses a scoped variable group", () => {
      expect(parseManifest(deployDir).variableGroups).toEqual([
        {
          name: "prod-analytics",
          environments: ["production"],
          variables: [
            { name: "ANALYTICS_WRITE_KEY", source: { kind: "generate" } },
          ],
        },
      ]);
    });
  });

  describe("parseManifest — null/scalar manifest", () => {
    it("does not crash when manifest.yml contains null", () => {
      write("manifest.yml", "null\n");
      expect(parseManifest(deployDir)).toEqual({
        environments: [],
        deployments: [],
        services: [],
        variables: [],
        variableGroups: [],
        overlays: {},
      });
    });

    it("does not crash when manifest.yml contains a bare scalar", () => {
      write("manifest.yml", "~\n");
      expect(parseManifest(deployDir)).toEqual({
        environments: [],
        deployments: [],
        services: [],
        variables: [],
        variableGroups: [],
        overlays: {},
      });
    });
  });

  describe("parseManifest — path traversal guard", () => {
    it("ignores environment names that would escape the deployment directory", () => {
      write("manifest.yml", "environments: [../../outside]\nvariables: {}\n");
      const secret = path.join(tmpDir, "outside.yml");
      fs.writeFileSync(secret, "SECRET: stolen\n");
      const manifest = parseManifest(deployDir);
      expect(manifest.overlays).not.toHaveProperty("../../outside");
    });
  });

  describe("parseManifest — legacy back-compat", () => {
    it("maps environments.yml + flat per-env files onto the model", () => {
      write("environments.yml", "active:\n  - production\n  - staging\n");
      write(
        "production.yml",
        'NEXT_PUBLIC_API_URL: "https://api.example.com"\n',
      );

      const manifest = parseManifest(deployDir);
      expect(manifest.environments).toEqual(["production", "staging"]);
      expect(manifest.deployments).toEqual([
        {
          provider: "vercel",
          targets: { production: "production", staging: "preview" },
        },
      ]);
      expect(manifest.services).toEqual([]);
      expect(manifest.variables).toEqual([]);
      expect(manifest.overlays).toEqual({
        production: { NEXT_PUBLIC_API_URL: "https://api.example.com" },
      });
    });

    it("returns an empty model when no config exists", () => {
      expect(parseManifest(deployDir)).toEqual({
        environments: [],
        deployments: [],
        services: [],
        variables: [],
        variableGroups: [],
        overlays: {},
      });
    });
  });

  describe("overlay precedence", () => {
    beforeEach(() => {
      write(
        "manifest.yml",
        [
          "environments: [production, staging]",
          "variables:",
          '  NEXT_PUBLIC_API_URL: { value: "https://api.default.example.com" }',
        ].join("\n") + "\n",
      );
      // Overlay overrides the declared base value for production only.
      write(
        "production.yml",
        'NEXT_PUBLIC_API_URL: "https://api.prod.example.com"\n',
      );
    });

    it("resolves the overlay value in the overridden environment", () => {
      expect(
        effectiveValue(
          parseManifest(deployDir),
          "production",
          "NEXT_PUBLIC_API_URL",
        ),
      ).toBe("https://api.prod.example.com");
    });

    it("falls back to the declared base value elsewhere", () => {
      expect(
        effectiveValue(
          parseManifest(deployDir),
          "staging",
          "NEXT_PUBLIC_API_URL",
        ),
      ).toBe("https://api.default.example.com");
    });

    it("returns undefined for a generated (non-literal) variable", () => {
      write(
        "manifest.yml",
        "environments: [production]\nvariables:\n  CRON_SECRET: { generate: true }\n",
      );
      expect(
        effectiveValue(parseManifest(deployDir), "production", "CRON_SECRET"),
      ).toBeUndefined();
    });

    it("ignores an overlay for a generate-sourced variable (source contract)", () => {
      write(
        "manifest.yml",
        "environments: [production]\nvariables:\n  CRON_SECRET: { generate: true }\n",
      );
      write("production.yml", "CRON_SECRET: injected-literal\n");
      expect(
        effectiveValue(parseManifest(deployDir), "production", "CRON_SECRET"),
      ).toBeUndefined();
    });
  });

  describe("variableVisibility", () => {
    it("treats a literal value as public", () => {
      expect(variableVisibility({ kind: "value", value: "x" })).toBe("public");
    });

    it("treats a generated secret as secret", () => {
      expect(variableVisibility({ kind: "generate" })).toBe("secret");
    });
  });
});
