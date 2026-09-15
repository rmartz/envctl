import { describe, expect, it } from "vitest";

import { FatalError } from "../../lib/logger";
import {
  resolveServiceProvider,
  serviceProviders,
} from "../../lib/providers/service";

describe("service provider registry", () => {
  it("lists firebase then sentry (order drives the rotation sequence)", () => {
    expect(serviceProviders().map((p) => p.provider)).toEqual([
      "firebase",
      "sentry",
    ]);
  });

  it("resolves a registered provider by its manifest name", () => {
    expect(resolveServiceProvider("firebase").displayName).toBe("Firebase");
    expect(resolveServiceProvider("sentry").displayName).toBe("Sentry");
  });

  it("errors, naming the offending value, for an unknown provider", () => {
    expect(() => resolveServiceProvider("datadog")).toThrow(FatalError);
    expect(() => resolveServiceProvider("datadog")).toThrow(/datadog/);
  });
});
