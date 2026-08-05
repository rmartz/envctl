import * as path from "path";

import { describe, expect, it } from "vitest";

import { FatalError } from "../lib/logger";
import { parseSecretsArgs } from "../lib/commands/secrets-args";

const WD = "/proj";

describe("parseSecretsArgs — rotate mode", () => {
  it("applies defaults with no arguments", () => {
    const opts = parseSecretsArgs([], WD, false);
    expect(opts).toEqual({
      targetEnv: "all",
      workingDir: WD,
      deploymentDir: path.resolve(WD, "deployment"),
      invalidateKeys: true,
      refreshPreviews: false,
      init: undefined,
    });
  });

  it("selects the environment from --env", () => {
    expect(parseSecretsArgs(["--env", "production"], WD, false).targetEnv).toBe(
      "production",
    );
  });

  it("--no-invalidate keeps the old keys", () => {
    expect(
      parseSecretsArgs(["--no-invalidate"], WD, false).invalidateKeys,
    ).toBe(false);
  });

  it("--refresh-previews enables the preview refresh", () => {
    expect(
      parseSecretsArgs(["--refresh-previews"], WD, false).refreshPreviews,
    ).toBe(true);
  });

  it("resolves --deployment-dir against the project root", () => {
    expect(
      parseSecretsArgs(["--deployment-dir", "cfg"], WD, false).deploymentDir,
    ).toBe(path.resolve(WD, "cfg"));
  });

  it("rejects a firebase/sentry positional in rotate mode", () => {
    expect(() => parseSecretsArgs(["firebase"], WD, false)).toThrow(FatalError);
  });

  it("rejects an unknown option", () => {
    expect(() => parseSecretsArgs(["--bogus"], WD, false)).toThrow(FatalError);
  });
});

describe("parseSecretsArgs — init mode", () => {
  it("defaults the init target to auto", () => {
    expect(parseSecretsArgs([], WD, true).init).toBe("auto");
  });

  it("reads a firebase positional", () => {
    expect(parseSecretsArgs(["firebase"], WD, true).init).toBe("firebase");
  });

  it("reads a sentry positional", () => {
    expect(parseSecretsArgs(["sentry"], WD, true).init).toBe("sentry");
  });

  it("combines the positional with flags", () => {
    const opts = parseSecretsArgs(
      ["firebase", "--env", "staging", "--refresh-previews"],
      WD,
      true,
    );
    expect(opts.init).toBe("firebase");
    expect(opts.targetEnv).toBe("staging");
    expect(opts.refreshPreviews).toBe(true);
  });
});
