import { describe, expect, it } from "vitest";

import { resolvePosthogVars } from "../../lib/posthog";
import { posthogServiceProvider } from "../../lib/providers/posthog";
import type { ServiceContext } from "../../lib/providers/service";
import type { DeploymentProvider } from "../../lib/providers/deployment";
import { resolveFirebaseCredential } from "../../lib/firebase-credential";

function makeContext(): ServiceContext {
  return {
    targetEnv: "production",
    deployment: {} as DeploymentProvider,
    tempDir: "",
    firebaseCredential: resolveFirebaseCredential(),
    posthogVars: resolvePosthogVars({
      provider: "posthog",
      variables: {
        projectKey: "PH_KEY",
        host: "PH_HOST",
        personalApiKey: "PH_ADMIN_KEY",
      },
    }),
  };
}

describe("posthogServiceProvider", () => {
  it("keys presence on the mapped personal API key", () => {
    expect(posthogServiceProvider.presenceKeys(makeContext())).toEqual([
      "PH_ADMIN_KEY",
    ]);
  });

  it("requires the mapped public project key and host", () => {
    expect(posthogServiceProvider.contractVars?.(makeContext())).toEqual([
      "PH_KEY",
      "PH_HOST",
    ]);
  });

  it("isolates the mapped project key across environments", () => {
    expect(posthogServiceProvider.isolatedVars?.(makeContext())).toEqual([
      "PH_KEY",
    ]);
  });
});
