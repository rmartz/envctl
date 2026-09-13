import { gcpAuthState, sentryAuthState } from "./auth";
import { err } from "./logger";
import { commandExists, run as runCmd } from "./subprocess";

// The set of providers a rotation/init run will act on, after presence
// detection and any per-provider scoping.
export interface ProviderSet {
  firebase: boolean;
  sentry: boolean;
  /** Sentry org slug — falls back to SENTRY_ORG env var. */
  sentryOrg?: string;
  /** Sentry project slug — falls back to SENTRY_PROJECT env var. */
  sentryProject?: string;
}

// Vercel is required for every flow: assert the CLI is installed, a token
// resolves, and the CLI session is authenticated, before any provider work.
export function checkVercelPrereqs(
  token: string | undefined,
): asserts token is string {
  if (!commandExists("vercel")) err("Missing required tools: vercel");

  if (!token)
    err(
      "No Vercel token found. Set VERCEL_TOKEN or run 'vercel login' to authenticate.",
    );

  try {
    runCmd("vercel", ["whoami"]);
  } catch {
    err("Vercel CLI not authenticated. Run: vercel login");
  }
}

// Fail-fast auth preflight (issue #91): before any mint/push, assert local auth
// for every provider that will be rotated/initialized, so an unauthenticated
// provider stops the run up front instead of after a sibling provider has
// already minted and pushed a new key — which would leave a partial, unverified
// state. Reports every missing provider at once with an actionable message.
export function assertProviderAuth(providers: ProviderSet): void {
  const missing: string[] = [];
  if (providers.firebase && !gcpAuthState().authenticated)
    missing.push(
      "gcp (Firebase) — install the gcloud CLI and run `gcloud auth login`",
    );
  if (providers.sentry) {
    if (!sentryAuthState().authenticated)
      missing.push("sentry — set SENTRY_AUTH_TOKEN or run `sentry-cli login`");
    const org = providers.sentryOrg ?? process.env.SENTRY_ORG;
    const project = providers.sentryProject ?? process.env.SENTRY_PROJECT;
    if (!org)
      missing.push("sentry — set SENTRY_ORG (Sentry organization slug)");
    if (!project)
      missing.push("sentry — set SENTRY_PROJECT (Sentry project slug)");
  }

  if (missing.length > 0)
    err(
      `Not authenticated or configured for provider(s) required by this operation:\n` +
        missing.map((m) => `  - ${m}`).join("\n") +
        `\nProvide the required credentials (see \`envctl auth status\`), or scope ` +
        `the run to a ready provider.`,
    );
}
