import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listActiveEnvs, parseDeploymentEnv } from "../lib/environments";
import { FatalError } from "../lib/logger";
import { runEnvAdd, runEnvList } from "../lib/commands/env";
import { runInit } from "../lib/commands/init";

describe("init / env add / env list", () => {
  let workingDir: string;
  let deployDir: string;

  beforeEach(() => {
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "envctl-cmd-"));
    deployDir = path.join(workingDir, "deployment");
    // Silence command logging.
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    fs.rmSync(workingDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const ctx = () => ({ workingDir });

  describe("init scaffolds a valid config and does not clobber", () => {
    it("creates environments.yml + a sample env file in an empty dir", () => {
      runInit(ctx());
      expect(listActiveEnvs(deployDir)).toEqual(["production"]);
      expect(parseDeploymentEnv(deployDir, "production")).toEqual({
        NEXT_PUBLIC_EXAMPLE: "replace-me",
      });
    });

    it("does not clobber an existing config on re-run", () => {
      runInit(ctx());
      fs.writeFileSync(
        path.join(deployDir, "environments.yml"),
        "active:\n  - production\n  - staging\n",
      );
      runInit(ctx());
      expect(listActiveEnvs(deployDir)).toEqual(["production", "staging"]);
    });
  });

  describe("env add appends to active and creates the env file", () => {
    it("adds staging --target preview and creates deployment/staging.yml", () => {
      runInit(ctx());
      runEnvAdd(ctx(), ["staging", "--target", "preview"]);
      expect(listActiveEnvs(deployDir)).toEqual(["production", "staging"]);
      expect(fs.existsSync(path.join(deployDir, "staging.yml"))).toBe(true);
    });

    it("rejects an invalid --target", () => {
      runInit(ctx());
      expect(() => runEnvAdd(ctx(), ["qa", "--target", "bogus"])).toThrow(
        FatalError,
      );
    });

    it("is a no-op for an already-active environment", () => {
      runInit(ctx());
      runEnvAdd(ctx(), ["production", "--target", "production"]);
      expect(listActiveEnvs(deployDir)).toEqual(["production"]);
    });

    it("errors when no config exists yet", () => {
      expect(() =>
        runEnvAdd(ctx(), ["staging", "--target", "preview"]),
      ).toThrow(FatalError);
    });
  });

  describe("env list reflects init + env add", () => {
    it("lists each active environment with its provider target", () => {
      runInit(ctx());
      runEnvAdd(ctx(), ["staging", "--target", "preview"]);
      const logSpy = vi.spyOn(console, "log");
      runEnvList(ctx());
      const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("production → production");
      expect(output).toContain("staging → preview");
    });
  });

  describe("round-trip: scaffolded config is valid engine input", () => {
    it("is readable by listActiveEnvs and parseDeploymentEnv after init + add", () => {
      runInit(ctx());
      runEnvAdd(ctx(), ["staging", "--target", "preview"]);
      // The engine functions config push relies on read it without error.
      expect(listActiveEnvs(deployDir)).toEqual(["production", "staging"]);
      expect(parseDeploymentEnv(deployDir, "staging")).toEqual({});
    });
  });
});
