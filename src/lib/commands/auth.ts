import {
  type AuthState,
  gcpAuthState,
  sentryAuthState,
  vercelAuthState,
} from "../auth";
import { log } from "../logger";

interface ProviderReport {
  name: string;
  state: AuthState;
  hint: string;
}

// `envctl auth status` — read-only report of each provider's credential state
// and source. envctl stores nothing itself; writing credentials is delegated to
// the providers' own CLIs (vercel login / gcloud auth login / sentry-cli login).
export function runAuthStatus(): void {
  const reports: ProviderReport[] = [
    {
      name: "vercel",
      state: vercelAuthState(),
      hint: "set VERCEL_TOKEN or run `vercel login`",
    },
    {
      name: "gcp",
      state: gcpAuthState(),
      hint: "install the gcloud CLI and run `gcloud auth login`",
    },
    {
      name: "sentry",
      state: sentryAuthState(),
      hint: "set SENTRY_AUTH_TOKEN or run `sentry-cli login`",
    },
  ];

  for (const { name, state, hint } of reports) {
    log(
      state.authenticated
        ? `${name.padEnd(7)} authenticated (${state.source})`
        : `${name.padEnd(7)} not authenticated — ${hint}`,
    );
  }
}
