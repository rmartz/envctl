import { generateSecretValue } from "../generated-secrets";
import {
  githubAppKeyFingerprint,
  readGithubAppPrivateKey,
  resolveGithubAppVars,
  type GithubAppConfig,
} from "../github-app";
import {
  checkGithubAppHookConfig,
  checkGithubAppKey,
  githubAppJwt,
  patchGithubAppHookConfig,
} from "../github-app-api";
import { err, log } from "../logger";
import type {
  ServiceContext,
  ServiceProvider,
  ServiceVarContext,
} from "./service";

const varsOf = (ctx: ServiceVarContext) =>
  ctx.githubApp?.vars ?? resolveGithubAppVars();

// The config the acting provider needs; the auth preflight has already
// asserted every piece is present, so a gap here is a programming error.
function requireConfig(ctx: ServiceContext): Required<GithubAppConfig> {
  const cfg = ctx.githubApp;
  if (!cfg?.privateKeyFile || !cfg.clientId || !cfg.webhookUrl)
    return err(
      "github-app: missing --private-key-file, Client ID or webhookUrl",
    );
  return cfg as Required<GithubAppConfig>;
}

function inScopeTargets(ctx: ServiceContext): string[] {
  const all =
    ctx.targetEnv === "all"
      ? ["production", "preview", "development"]
      : [ctx.targetEnv];
  return all.filter(
    (t) => !ctx.allowedTargets || ctx.allowedTargets.includes(t),
  );
}

// Vercel's sensitive (write-only) type exists only for production and preview.
const secretType = (target: string) =>
  target === "development" ? "encrypted" : "sensitive";

// Push the App private key and webhook secret to each target.
async function pushSecrets(
  ctx: ServiceContext,
  cfg: Required<GithubAppConfig>,
  targets: string[],
  pem: string,
  secret: string,
): Promise<void> {
  const { envs } = await ctx.deployment.listEnvVars();
  for (const target of targets) {
    for (const [key, value] of [
      [cfg.vars.privateKey, pem],
      [cfg.vars.webhookSecret, secret],
    ] as const)
      await ctx.deployment.setEnvForTarget(
        key,
        value,
        target,
        envs,
        secretType(target),
      );
    log(
      `  [${target}] Pushed ${cfg.vars.privateKey} and ${cfg.vars.webhookSecret}`,
    );
  }
}

// Run once the redeploy is READY: prove the pushed key authenticates as the
// App (`GET /app`), then PATCH the App's webhook to the configured URL with
// `secret`. A failed proof leaves GitHub's webhook config untouched.
async function activateWebhook(
  cfg: Required<GithubAppConfig>,
  secret: string,
): Promise<string> {
  const { key } = readGithubAppPrivateKey(cfg.privateKeyFile);
  const jwt = githubAppJwt(cfg.clientId, key);
  await checkGithubAppKey(jwt);
  await patchGithubAppHookConfig(jwt, cfg.webhookUrl, secret);
  log(`  Pointed the GitHub App webhook at ${cfg.webhookUrl}`);
  return githubAppKeyFingerprint(key);
}

// A Vercel-hosted GitHub App server (#201). init and rotate both push the App
// private key from the local PEM and a freshly minted webhook secret as
// sensitive vars, so a rotate given a newly generated key rotates both (#206).
// GitHub's webhook config is PATCHed only in `activate`, which the engine runs
// after the redeploy is READY and after the key is proven against `GET /app`,
// so a failed push, deploy or proof leaves GitHub on the old secret.
export const githubAppServiceProvider: ServiceProvider = {
  provider: "github-app",
  displayName: "GitHub App",
  authKey: "github-app",
  // Selected only by name or by auto-detection of a declared service, never by
  // `init all` (which predates it and means Firebase + Sentry).
  explicitInit: true,
  presenceKeys: (ctx) => [varsOf(ctx).webhookSecret, varsOf(ctx).privateKey],
  contractVars: (ctx) => [varsOf(ctx).privateKey, varsOf(ctx).webhookSecret],
  // Prove the JWT is accepted and the App's webhook is active before a secret
  // is minted, so a failure can't leave Vercel with a secret GitHub lacks.
  preflight: async (ctx) => {
    const cfg = requireConfig(ctx);
    const { key } = readGithubAppPrivateKey(cfg.privateKeyFile);
    await checkGithubAppHookConfig(githubAppJwt(cfg.clientId, key));
  },
  init: async (ctx) => {
    const cfg = requireConfig(ctx);
    const { pem } = readGithubAppPrivateKey(cfg.privateKeyFile);
    const secret = generateSecretValue();
    log("Initializing GitHub App secrets...");
    await pushSecrets(ctx, cfg, inScopeTargets(ctx), pem, secret);
    return {
      activate: async () => {
        await activateWebhook(cfg, secret);
      },
    };
  },
  rotate: async (ctx) => {
    const cfg = requireConfig(ctx);
    const { pem } = readGithubAppPrivateKey(cfg.privateKeyFile);
    const secret = generateSecretValue();
    log("Rotating GitHub App private key and webhook secret...");
    const { envs } = await ctx.deployment.listEnvVars();
    // Every provisioned target (either var present) gets the new values, so
    // GitHub is never PATCHed with a secret the server lacks.
    const targets = inScopeTargets(ctx).filter((target) =>
      [cfg.vars.webhookSecret, cfg.vars.privateKey].some((key) =>
        ctx.deployment.findEnvVar(envs, key, target),
      ),
    );
    if (targets.length === 0)
      err(
        `No in-scope Vercel target holds ${cfg.vars.webhookSecret} or ${cfg.vars.privateKey} — nothing to rotate.`,
      );
    await pushSecrets(ctx, cfg, targets, pem, secret);
    return {
      activate: async () => {
        const fingerprint = await activateWebhook(cfg, secret);
        log(
          `  ${cfg.vars.privateKey} is now the App key ${fingerprint} (proven against GET /app). If it replaced an older key that nothing else uses, delete that key on the App's settings page; keep any key other consumers, such as GitHub Actions secrets, still use.`,
        );
      },
      // The retired webhook secret dies with the PATCH, and envctl cannot
      // delete App keys (GitHub has no API for it).
      invalidate: () => Promise.resolve(),
      retiredKeyWarnings: () => [],
    };
  },
};
