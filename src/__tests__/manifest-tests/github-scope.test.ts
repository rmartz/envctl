import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { githubSecretAmbiguities } from "../../lib/github-secret-scope";
import { resolveGithubSecrets } from "../../lib/github-secrets";
import { manifestErrors, parseManifest } from "../../lib/manifest";

let workingDir: string;
let root: string;

beforeEach(() => {
  workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "github-scope-"));
  root = path.join(workingDir, "deployment");
  fs.mkdirSync(root);
});

afterEach(() => {
  fs.rmSync(workingDir, { recursive: true, force: true });
});

// Both deployments push CRON_SECRET (top level); only gate pushes GATE_ONLY.
function makeRoot(secrets: string[]): void {
  fs.writeFileSync(
    path.join(root, "manifest.yml"),
    [
      "environments: [production]",
      "variables:",
      "  CRON_SECRET: { generate: true }",
      "deployments:",
      "  - name: actor",
      "    provider: vercel",
      "    targets: { production: production }",
      "  - name: gate",
      "    provider: vercel",
      "    targets: { production: production }",
      "    variables:",
      "      GATE_ONLY: { generate: true }",
      "github:",
      "  repo: acme/app",
      "  secrets:",
      ...secrets,
    ].join("\n") + "\n",
  );
}

describe("GitHub secret mirroring per deployment", () => {
  it("mirrors a scoped secret only from its deployment's view", () => {
    makeRoot([
      "    - variable: CRON_SECRET",
      "      environment: production",
      "      name: GATE_CRON",
      "      deployment: gate",
    ]);
    expect([
      resolveGithubSecrets(path.join(root, "gate")).map((t) => t.secretName),
      resolveGithubSecrets(path.join(root, "actor")).map((t) => t.secretName),
    ]).toEqual([["GATE_CRON"], []]);
  });

  it("flags an unscoped secret whose variable several deployments push", () => {
    makeRoot(["    - variable: CRON_SECRET", "      environment: production"]);
    expect(githubSecretAmbiguities(root, parseManifest(root))).toEqual([
      "GitHub secret CRON_SECRET mirrors CRON_SECRET, which deployments actor, gate all push — set its 'deployment' so one doesn't overwrite another's value.",
    ]);
  });

  it("allows an unscoped secret only one deployment pushes", () => {
    makeRoot(["    - variable: GATE_ONLY", "      environment: production"]);
    expect(githubSecretAmbiguities(root, parseManifest(root))).toEqual([]);
  });

  it("reports a secret scoped to an undeclared deployment", () => {
    makeRoot([
      "    - variable: CRON_SECRET",
      "      environment: production",
      "      deployment: docs",
    ]);
    expect(manifestErrors(parseManifest(root))).toEqual([
      "GitHub secret for CRON_SECRET names undeclared deployment 'docs'.",
    ]);
  });
});
