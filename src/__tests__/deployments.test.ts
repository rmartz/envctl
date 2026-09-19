import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { triggerAndWaitRedeployments } from "../lib/deployments";
import { VercelClient } from "../lib/vercel-api";

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

// #125 — a CANCELED verification redeploy is benign (the credential was already
// pushed); the run must not abort with a stack trace.
describe("triggerAndWaitRedeployments (#125)", () => {
  it("warns and completes when a redeploy is CANCELED, instead of throwing", async () => {
    vi.spyOn(VercelClient.prototype, "getLatestDeployment").mockResolvedValue({
      uid: "d1",
      name: "proj",
      url: "proj.vercel.app",
    });
    vi.spyOn(VercelClient.prototype, "triggerRedeployment").mockResolvedValue(
      "dpl_new",
    );
    vi.spyOn(VercelClient.prototype, "pollDeploymentStatus").mockResolvedValue(
      "canceled",
    );
    const warnSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const client = new VercelClient("tok", "prj");
    await expect(
      triggerAndWaitRedeployments("production", client),
    ).resolves.toBeUndefined();
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
      /CANCELED/,
    );
    expect(logSpy.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
      /Redeployment polling complete/,
    );
    expect(logSpy.mock.calls.map((c) => String(c[0])).join("\n")).not.toMatch(
      /All deployments ready/,
    );
  });

  it("logs 'All deployments ready.' when all deployments succeed", async () => {
    vi.spyOn(VercelClient.prototype, "getLatestDeployment").mockResolvedValue({
      uid: "d1",
      name: "proj",
      url: "proj.vercel.app",
    });
    vi.spyOn(VercelClient.prototype, "triggerRedeployment").mockResolvedValue(
      "dpl_new",
    );
    vi.spyOn(VercelClient.prototype, "pollDeploymentStatus").mockResolvedValue(
      "ready",
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const client = new VercelClient("tok", "prj");
    await triggerAndWaitRedeployments("production", client);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
      /All deployments ready/,
    );
  });

  it("propagates a genuine deployment failure", async () => {
    vi.spyOn(VercelClient.prototype, "getLatestDeployment").mockResolvedValue({
      uid: "d1",
      name: "proj",
      url: "proj.vercel.app",
    });
    vi.spyOn(VercelClient.prototype, "triggerRedeployment").mockResolvedValue(
      "dpl_new",
    );
    vi.spyOn(VercelClient.prototype, "pollDeploymentStatus").mockRejectedValue(
      new Error("Deployment dpl_new ended with status: ERROR"),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const client = new VercelClient("tok", "prj");
    await expect(
      triggerAndWaitRedeployments("production", client),
    ).rejects.toThrow(/ERROR/);
  });
});
