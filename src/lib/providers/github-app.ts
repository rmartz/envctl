import { generateSecretValue } from "../generated-secrets";
import {
  checkGithubAppHookConfig,
  githubAppJwt,
  githubAppKeyManualSteps,
  patchGithubAppHookConfig,
  readGithubAppPrivateKey,
  resolveGithubAppVars,
  type GithubAppConfig,
} from "../github-app";
import { err, log, warn } from "../logger";
import type { ServiceContext, ServiceProvider } from "./service";

const varsOf = (ctx: ServiceContext) =>
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

// PATCH the App's webhook to the configured URL with `secret`, signing the
// request as the App. Run only after the redeploy proves the secret live.
async function activateWebhook(
  cfg: Required<GithubAppConfig>,
  secret: string,
): Promise<void> {
  const { key } = readGithubAppPrivateKey(cfg.privateKeyFile);
  await patchGithubAppHookConfig(
    githubAppJwt(cfg.clientId, key),
    cfg.webhookUrl,
    secret,
  );
  log(`  Pointed the GitHub App webhook at ${cfg.webhookUrl}`);
}

// A Vercel-hosted GitHub App server (#201). init pushes the App private key
// (from a local PEM) and a freshly minted webhook secret as sensitive vars;
// rotate re-mints the webhook secret. Either way GitHub's webhook config is
// PATCHed only in `activate`, which the engine runs after the redeploy is READY,
// so a failed push or deploy leaves GitHub on the old secret. The private key
// itself cannot be minted by API, so rotate only prints its manual steps.
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
    const { envs } = await ctx.deployment.listEnvVars();
    for (const target of inScopeTargets(ctx)) {
      const type = secretType(target);
      await ctx.deployment.setEnvForTarget(
        cfg.vars.privateKey,
        pem,
        target,
        envs,
        type,
      );
      await ctx.deployment.setEnvForTarget(
        cfg.vars.webhookSecret,
        secret,
        target,
        envs,
        type,
      );
      log(
        `  [${target}] Pushed ${cfg.vars.privateKey} and ${cfg.vars.webhookSecret}`,
      );
    }
    return { activate: () => activateWebhook(cfg, secret) };
  },
  rotate: async (ctx) => {
    const cfg = requireConfig(ctx);
    warn(githubAppKeyManualSteps(cfg.vars));
    const secret = generateSecretValue();
    log("Rotating GitHub App webhook secret...");
    const { envs } = await ctx.deployment.listEnvVars();
    // Every provisioned target (either var present) gets the new secret, so
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
    for (const target of targets) {
      await ctx.deployment.setEnvForTarget(
        cfg.vars.webhookSecret,
        secret,
        target,
        envs,
        secretType(target),
      );
      log(`  [${target}] Rotated ${cfg.vars.webhookSecret}`);
    }
    return {
      activate: () => activateWebhook(cfg, secret),
      // The retired secret dies with the PATCH; there is nothing to revoke.
      invalidate: () => Promise.resolve(),
      retiredKeyWarnings: () => [],
    };
  },
};
