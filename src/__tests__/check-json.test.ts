import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCheck } from "../lib/commands/check";
import { FatalError } from "../lib/logger";
import { makeManifestDir } from "./fixtures";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "check-json-"));
  vi.stubEnv("VERCEL_PROJECT_ID", "prj_test");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const HEADER = [
  "environments: [production]",
  "deployments:",
  "  - provider: vercel",
  "    targets:",
  "      production: production",
];

// Run `check --json`, returning the parsed stdout and whether it threw.
async function runJson(): Promise<{ parsed: unknown; threw: boolean }> {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  let threw = false;
  try {
    await runCheck({ workingDir: tmpDir }, ["--json"]);
  } catch (e) {
    threw = e instanceof FatalError;
  }
  return { parsed: JSON.parse(String(logSpy.mock.calls[0][0])), threw };
}

describe("runCheck --json — machine-readable findings", () => {
  it("prints an empty array for a clean project", async () => {
    makeManifestDir(tmpDir, HEADER);
    expect((await runJson()).parsed).toEqual([]);
  });

  it("emits each finding with severity, kind, and message", async () => {
    makeManifestDir(tmpDir, [...HEADER, "services:", "  - provider: nonesuch"]);
    const [finding] = (await runJson()).parsed as Record<string, string>[];
    expect({ ...finding, message: /nonesuch/.test(finding.message) }).toEqual({
      severity: "error",
      kind: "general",
      message: true,
    });
  });

  it("still exits non-zero when a finding is an error", async () => {
    makeManifestDir(tmpDir, [...HEADER, "services:", "  - provider: nonesuch"]);
    expect((await runJson()).threw).toBe(true);
  });
});
