import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseDeploymentEnv } from "../lib/environments";

describe("parseDeploymentEnv", () => {
  let tmpDir: string;
  let deployDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-test-"));
    deployDir = path.join(tmpDir, "deployment");
    fs.mkdirSync(deployDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeYaml(envName: string, content: string): void {
    fs.writeFileSync(path.join(deployDir, `${envName}.yml`), content);
  }

  it("returns empty object when file does not exist", () => {
    expect(parseDeploymentEnv(deployDir, "staging")).toEqual({});
  });

  it("parses flat key-value YAML", () => {
    writeYaml(
      "staging",
      `NEXT_PUBLIC_API_URL: "https://api.staging.example.com"\nFIREBASE_PROJECT_ID: "my-project-staging"\n`,
    );
    expect(parseDeploymentEnv(deployDir, "staging")).toEqual({
      NEXT_PUBLIC_API_URL: "https://api.staging.example.com",
      FIREBASE_PROJECT_ID: "my-project-staging",
    });
  });

  it("parses nested variables: format", () => {
    writeYaml(
      "staging",
      [
        "environment: staging",
        "variables:",
        '  NEXT_PUBLIC_API_URL: "https://api.staging.example.com"',
        '  FIREBASE_SA_EMAIL: "sa@project.iam.gserviceaccount.com"',
        '  FIREBASE_PROJECT_ID: "my-project"',
      ].join("\n") + "\n",
    );
    expect(parseDeploymentEnv(deployDir, "staging")).toEqual({
      NEXT_PUBLIC_API_URL: "https://api.staging.example.com",
      FIREBASE_SA_EMAIL: "sa@project.iam.gserviceaccount.com",
      FIREBASE_PROJECT_ID: "my-project",
    });
  });

  it("excludes top-level metadata keys (environment:) in nested format", () => {
    writeYaml("staging", "environment: staging\nvariables:\n  KEY: value\n");
    const result = parseDeploymentEnv(deployDir, "staging");
    expect(result).toEqual({ KEY: "value" });
    expect(result).not.toHaveProperty("environment");
  });

  it("skips null and empty values", () => {
    writeYaml(
      "staging",
      'variables:\n  PRESENT: "hello"\n  EMPTY: ""\n  NULL_VAL: ~\n',
    );
    expect(parseDeploymentEnv(deployDir, "staging")).toEqual({
      PRESENT: "hello",
    });
  });

  it("converts boolean values to lowercase strings", () => {
    writeYaml("staging", "variables:\n  FLAG_ON: true\n  FLAG_OFF: false\n");
    expect(parseDeploymentEnv(deployDir, "staging")).toEqual({
      FLAG_ON: "true",
      FLAG_OFF: "false",
    });
  });

  it("returns empty object for empty file", () => {
    writeYaml("staging", "");
    expect(parseDeploymentEnv(deployDir, "staging")).toEqual({});
  });

  it("returns empty object when YAML root is a scalar", () => {
    writeYaml("staging", "just a string\n");
    expect(parseDeploymentEnv(deployDir, "staging")).toEqual({});
  });

  it("returns empty object when YAML root is an array", () => {
    writeYaml("staging", "- item1\n- item2\n");
    expect(parseDeploymentEnv(deployDir, "staging")).toEqual({});
  });
});
