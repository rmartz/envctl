import { err } from "../logger";
import { posthogManualSteps, resolvePosthogVars } from "../posthog";
import type { ServiceContext, ServiceProvider } from "./service";

const varsOf = (ctx: ServiceContext) => ctx.posthogVars ?? resolvePosthogVars();

// PostHog (#173). Its only secret is the optional personal API key, which the
// PostHog API will not mint or delete for an API-key-authenticated caller — so
// the provider is manual-only: the rotation engine never calls init/rotate on it
// (it reports `manualSteps` instead), and they refuse if called directly. The
// public project key / host are plain literals pushed by `config push`.
export const posthogServiceProvider: ServiceProvider = {
  provider: "posthog",
  displayName: "PostHog",
  // Never acts in a rotation, so it needs no slot in the auth preflight.
  authKey: "none",
  // Keyed on the secret, not the public project key: a project that only uses
  // the public key has nothing to rotate.
  presenceKeys: (ctx) => [varsOf(ctx).personalApiKey],
  manualSteps: (ctx) => posthogManualSteps(varsOf(ctx)),
  init: (ctx) => err(posthogManualSteps(varsOf(ctx))),
  rotate: (ctx) => err(posthogManualSteps(varsOf(ctx))),
};
