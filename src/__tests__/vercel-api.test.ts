import { afterEach, describe, expect, it, vi } from "vitest";

import { VercelClient } from "../lib/vercel-api";

const client = (): VercelClient => new VercelClient("tok", "prj");

afterEach(() => vi.restoreAllMocks());

// #125 — a benign auto-cancel (Vercel supersedes a redeploy) must not be
// treated as a hard failure.
describe("pollDeploymentStatus (#125)", () => {
  it("returns 'ready' when the deployment reaches READY", async () => {
    vi.spyOn(VercelClient.prototype, "request").mockResolvedValue({
      status: "READY",
    });
    await expect(client().pollDeploymentStatus("dpl", 3, 0)).resolves.toBe(
      "ready",
    );
  });

  it("returns 'canceled' (does not throw) when the deployment is CANCELED", async () => {
    vi.spyOn(VercelClient.prototype, "request").mockResolvedValue({
      status: "CANCELED",
    });
    await expect(client().pollDeploymentStatus("dpl", 3, 0)).resolves.toBe(
      "canceled",
    );
  });

  it("still throws on a genuine ERROR", async () => {
    vi.spyOn(VercelClient.prototype, "request").mockResolvedValue({
      status: "ERROR",
    });
    await expect(client().pollDeploymentStatus("dpl", 3, 0)).rejects.toThrow(
      /ERROR/,
    );
  });

  it("throws on timeout when the deployment never reaches a terminal state", async () => {
    vi.spyOn(VercelClient.prototype, "request").mockResolvedValue({
      status: "BUILDING",
    });
    await expect(client().pollDeploymentStatus("dpl", 2, 0)).rejects.toThrow(
      /timed out/,
    );
  });
});
