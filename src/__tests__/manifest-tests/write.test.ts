import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseManifest, setManifestEnvironments } from "../../lib/manifest";

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

  describe("setManifestEnvironments", () => {
    it("preserves comments and untouched keys when updating the list", () => {
      write(
        "manifest.yml",
        [
          "# envctl deployment manifest",
          "environments: [production]",
          "services:",
          "  - provider: firebase # keep this comment",
        ].join("\n") + "\n",
      );

      setManifestEnvironments(deployDir, ["production", "staging"]);

      const text = fs.readFileSync(
        path.join(deployDir, "manifest.yml"),
        "utf-8",
      );
      expect(text).toContain("# envctl deployment manifest");
      expect(text).toContain("# keep this comment");
      expect(parseManifest(deployDir).environments).toEqual([
        "production",
        "staging",
      ]);
      // The untouched services block still parses.
      expect(parseManifest(deployDir).services).toEqual([
        { provider: "firebase" },
      ]);
    });

    it("creates a new manifest when none exists", () => {
      setManifestEnvironments(deployDir, ["production"]);
      expect(fs.existsSync(path.join(deployDir, "manifest.yml"))).toBe(true);
      expect(parseManifest(deployDir).environments).toEqual(["production"]);
    });

    it("preserves an inline comment on a surviving entry when adding one (#104)", () => {
      write(
        "manifest.yml",
        ["environments:", "  - production # primary", "  - staging"].join(
          "\n",
        ) + "\n",
      );

      setManifestEnvironments(deployDir, ["production", "staging", "qa"]);

      const text = fs.readFileSync(
        path.join(deployDir, "manifest.yml"),
        "utf-8",
      );
      expect(text).toMatch(/production\s+# primary/);
      expect(parseManifest(deployDir).environments).toEqual([
        "production",
        "staging",
        "qa",
      ]);
    });

    it("carries an entry's inline comment with it when the order changes", () => {
      write(
        "manifest.yml",
        ["environments:", "  - production # prod", "  - staging # stg"].join(
          "\n",
        ) + "\n",
      );

      setManifestEnvironments(deployDir, ["staging", "production"]);

      const text = fs.readFileSync(
        path.join(deployDir, "manifest.yml"),
        "utf-8",
      );
      expect(text).toMatch(/staging\s+# stg/);
      expect(text).toMatch(/production\s+# prod/);
      // staging now precedes production.
      expect(text.indexOf("staging")).toBeLessThan(text.indexOf("production"));
    });

    it("drops the entry (and its comment) for a removed environment", () => {
      write(
        "manifest.yml",
        ["environments:", "  - production # keep", "  - staging # remove"].join(
          "\n",
        ) + "\n",
      );

      setManifestEnvironments(deployDir, ["production"]);

      const text = fs.readFileSync(
        path.join(deployDir, "manifest.yml"),
        "utf-8",
      );
      expect(text).toMatch(/production\s+# keep/);
      expect(text).not.toContain("# remove");
      expect(parseManifest(deployDir).environments).toEqual(["production"]);
    });
  });
});
