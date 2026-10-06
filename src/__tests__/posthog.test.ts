import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FatalError } from "../lib/logger";
import {
  assertPosthogProjectIsolation,
  posthogManualSteps,
  resolvePosthogVars,
} from "../lib/posthog";
import { makeDeploymentDir } from "./fixtures";

describe("resolvePosthogVars", () => {
  it("uses the default names when no service is declared", () => {
    expect(resolvePosthogVars()).toEqual({
      projectKey: "NEXT_PUBLIC_POSTHOG_KEY",
      host: "NEXT_PUBLIC_POSTHOG_HOST",
      personalApiKey: "POSTHOG_PERSONAL_API_KEY",
    });
  });

  it("applies a field override from the manifest variables map", () => {
    const names = resolvePosthogVars({
      provider: "posthog",
      variables: { personalApiKey: "PH_ADMIN_KEY" },
    });
    expect(names.personalApiKey).toBe("PH_ADMIN_KEY");
  });

  it("rejects an unknown field", () => {
    expect(() =>
      resolvePosthogVars({ provider: "posthog", variables: { token: "X" } }),
    ).toThrow(/Unknown PostHog variable field 'token'/);
  });

  it("rejects an empty override", () => {
    expect(() =>
      resolvePosthogVars({ provider: "posthog", variables: { host: " " } }),
    ).toThrow(/must not be empty/);
  });

  it("rejects two fields mapped to the same name", () => {
    expect(() =>
      resolvePosthogVars({
        provider: "posthog",
        variables: { host: "NEXT_PUBLIC_POSTHOG_KEY" },
      }),
    ).toThrow(/must be unique/);
  });
});

describe("posthogManualSteps", () => {
  it("names the resolved personal-key var in the vercel commands", () => {
    const steps = posthogManualSteps(
      resolvePosthogVars({
        provider: "posthog",
        variables: { personalApiKey: "PH_ADMIN_KEY" },
      }),
    );
    expect(steps).toContain("vercel env add PH_ADMIN_KEY <target> --sensitive");
  });
});

describe("assertPosthogProjectIsolation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posthog-iso-"));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("allows distinct project keys per environment", () => {
    const dir = makeDeploymentDir(tmpDir, ["production", "staging"], {
      production: { NEXT_PUBLIC_POSTHOG_KEY: "phc_prod" },
      staging: { NEXT_PUBLIC_POSTHOG_KEY: "phc_staging" },
    });
    expect(() =>
      assertPosthogProjectIsolation(dir, ["production", "staging"]),
    ).not.toThrow();
  });

  it("refuses a project key shared by production and staging", () => {
    const dir = makeDeploymentDir(tmpDir, ["production", "staging"], {
      production: { NEXT_PUBLIC_POSTHOG_KEY: "phc_same" },
      staging: { NEXT_PUBLIC_POSTHOG_KEY: "phc_same" },
    });
    expect(() =>
      assertPosthogProjectIsolation(dir, ["production", "staging"]),
    ).toThrow(FatalError);
  });

  it("allows a shared key between environments on the same target", () => {
    const dir = makeDeploymentDir(tmpDir, ["staging", "preview"], {
      staging: { NEXT_PUBLIC_POSTHOG_KEY: "phc_same" },
      preview: { NEXT_PUBLIC_POSTHOG_KEY: "phc_same" },
    });
    expect(() =>
      assertPosthogProjectIsolation(dir, ["staging", "preview"]),
    ).not.toThrow();
  });

  it("checks the overridden project-key var name from the manifest", () => {
    const dir = makeDeploymentDir(tmpDir, ["production", "staging"], {
      production: { PH_KEY: "phc_same" },
      staging: { PH_KEY: "phc_same" },
    });
    fs.writeFileSync(
      path.join(dir, "manifest.yml"),
      "services:\n  - provider: posthog\n    variables:\n      projectKey: PH_KEY\n",
    );
    expect(() =>
      assertPosthogProjectIsolation(dir, ["production", "staging"]),
    ).toThrow(/PH_KEY is identical/);
  });
});
