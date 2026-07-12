import * as fs from "fs";
import * as os from "os";
import * as path from "path";

interface VercelAuth {
  token?: string;
  expiresAt?: number;
}

function vercelCliAuthPath(): string {
  if (process.env.__VERCEL_CLI_AUTH_PATH)
    return process.env.__VERCEL_CLI_AUTH_PATH;
  switch (process.platform) {
    case "darwin":
      return path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "com.vercel.cli",
        "auth.json",
      );
    case "win32":
      return path.join(
        process.env.APPDATA ?? os.homedir(),
        "com.vercel.cli",
        "auth.json",
      );
    default:
      return path.join(
        process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
        "com.vercel.cli",
        "auth.json",
      );
  }
}

function readCliToken(): string | undefined {
  const authPath = vercelCliAuthPath();
  let raw: string;
  try {
    raw = fs.readFileSync(authPath, "utf-8");
  } catch {
    return undefined;
  }

  let auth: VercelAuth;
  try {
    auth = JSON.parse(raw) as VercelAuth;
  } catch {
    return undefined;
  }

  if (!auth.token) return undefined;

  if (auth.expiresAt !== undefined && Date.now() / 1000 > auth.expiresAt) {
    return undefined;
  }

  return auth.token;
}

/**
 * Returns the Vercel API token to use, preferring VERCEL_TOKEN env var and
 * falling back to the token stored by the Vercel CLI (vercel login).
 *
 * Returns undefined if no token is available.
 */
export function resolveVercelToken(): string | undefined {
  return process.env.VERCEL_TOKEN ?? readCliToken() ?? undefined;
}

function sentryClircPath(): string {
  return (
    process.env.__SENTRY_CLIRC_PATH ?? path.join(os.homedir(), ".sentryclirc")
  );
}

// Reads the `token = …` value from sentry-cli's ~/.sentryclirc (INI-style).
// Graceful: a missing or unparseable file yields undefined.
function readSentryClircToken(): string | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(sentryClircPath(), "utf-8");
  } catch {
    return undefined;
  }
  const match = /^\s*token\s*=\s*(\S+)\s*$/m.exec(raw);
  return match ? match[1] : undefined;
}

/**
 * Returns the Sentry auth token, preferring SENTRY_AUTH_TOKEN and falling back
 * to the token stored by sentry-cli (`sentry-cli login` → ~/.sentryclirc).
 * Returns undefined if none is available.
 */
export function resolveSentryToken(): string | undefined {
  // `||` (not `??`) so a blank SENTRY_AUTH_TOKEN falls through to the CLI store.
  return process.env.SENTRY_AUTH_TOKEN || readSentryClircToken() || undefined;
}

// Read-only auth state for `envctl auth status` — reports whether a provider's
// credential resolves and, when it does, its human-readable source. Never
// exposes the token value.
export interface AuthState {
  authenticated: boolean;
  source?: string;
}

export function vercelAuthState(): AuthState {
  if (process.env.VERCEL_TOKEN)
    return { authenticated: true, source: "VERCEL_TOKEN env var" };
  if (readCliToken()) return { authenticated: true, source: "vercel login" };
  return { authenticated: false };
}

export function sentryAuthState(): AuthState {
  if (process.env.SENTRY_AUTH_TOKEN)
    return { authenticated: true, source: "SENTRY_AUTH_TOKEN env var" };
  if (readSentryClircToken())
    return { authenticated: true, source: "sentry-cli login (~/.sentryclirc)" };
  return { authenticated: false };
}
