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
