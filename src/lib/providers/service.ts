import {
  firebasePresenceKeys,
  type FirebaseCredentialSpec,
} from "../firebase-credential";
import {
  initFirebase,
  invalidateFirebaseKeys,
  rotateFirebase,
} from "../firebase";
import { err } from "../logger";
import { initSentry, invalidateSentryKey, rotateSentry } from "../sentry";
import type { DeploymentProvider } from "./deployment";

// Context handed to every service provider for a run — the superset of
// provider-specific inputs; each provider reads only what it needs. `tempDir`
// is filled in once the run's scratch directory exists.
export interface ServiceContext {
  targetEnv: string;
  deployment: DeploymentProvider;
  tempDir: string;
  firebaseCredential: FirebaseCredentialSpec;
  firebaseSaEmail?: string;
  gcpProject?: string;
  sentryOrg?: string;
  sentryProject?: string;
}

// The outcome of rotating one service: how to invalidate the retired credential
// after the redeploy proves the new one live, and how to describe it when
// invalidation is skipped (`--no-invalidate`).
export interface ServiceRotation {
  invalidate(): Promise<void>;
  retiredKeyWarnings(): string[];
}

// A secret source — the manifest `services[].provider`. Mints, rotates, and
// invalidates the credential vars it owns. The rotation engine iterates these
// generically instead of referencing Firebase/Sentry by name.
export interface ServiceProvider {
  readonly provider: string;
  readonly displayName: string;
  /** Which slot this provider fills in the fail-fast auth preflight. */
  readonly authKey: "firebase" | "sentry";
  /** Env-var keys whose presence in Vercel means this service is provisioned. */
  presenceKeys(ctx: ServiceContext): string[];
  init(ctx: ServiceContext): Promise<void>;
  rotate(ctx: ServiceContext): Promise<ServiceRotation>;
}

const firebaseServiceProvider: ServiceProvider = {
  provider: "firebase",
  displayName: "Firebase",
  authKey: "firebase",
  presenceKeys: (ctx) => firebasePresenceKeys(ctx.firebaseCredential),
  init: (ctx) =>
    initFirebase(
      ctx.targetEnv,
      ctx.deployment,
      ctx.tempDir,
      ctx.firebaseSaEmail,
      ctx.gcpProject,
      ctx.firebaseCredential,
    ),
  rotate: async (ctx) => {
    const { oldKeys, fp } = await rotateFirebase(
      ctx.targetEnv,
      ctx.deployment,
      ctx.tempDir,
      ctx.firebaseCredential,
    );
    return {
      invalidate: async () => {
        if (fp) await invalidateFirebaseKeys(ctx.deployment, fp);
      },
      retiredKeyWarnings: () =>
        oldKeys.map(
          ({ vercelEnv, keyId, saEmail }) =>
            `Old Firebase key to remove: ${keyId} (${vercelEnv}, account: ${saEmail})`,
        ),
    };
  },
};

// Resolve Sentry org/project from the context override or the environment —
// mirroring rotation's invalidation-time resolution.
function sentryOrgProject(ctx: ServiceContext): {
  org: string | undefined;
  project: string | undefined;
} {
  return {
    org: ctx.sentryOrg ?? process.env.SENTRY_ORG,
    project: ctx.sentryProject ?? process.env.SENTRY_PROJECT,
  };
}

const sentryServiceProvider: ServiceProvider = {
  provider: "sentry",
  displayName: "Sentry",
  authKey: "sentry",
  presenceKeys: () => ["SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN"],
  init: (ctx) =>
    initSentry(ctx.targetEnv, ctx.deployment, ctx.sentryOrg, ctx.sentryProject),
  rotate: async (ctx) => {
    const oldKeyId = await rotateSentry(
      ctx.targetEnv,
      ctx.deployment,
      ctx.sentryOrg,
      ctx.sentryProject,
    );
    return {
      invalidate: async () => {
        if (!oldKeyId) return;
        const { org, project } = sentryOrgProject(ctx);
        if (!org || !project)
          return err(
            "SENTRY_ORG and SENTRY_PROJECT are required for key invalidation",
          );
        await invalidateSentryKey(oldKeyId, org, project);
      },
      retiredKeyWarnings: () => {
        if (!oldKeyId) return [];
        const { org, project } = sentryOrgProject(ctx);
        return [
          `Old Sentry key to remove: ${oldKeyId} (project: ${org}/${project})`,
        ];
      },
    };
  },
};

// The secret sources envctl knows how to rotate, keyed by the manifest
// `services[].provider` discriminant. Order is significant: providers act in
// this order, so the fail-fast auth preflight and the rotation sequence stay
// Firebase-before-Sentry, matching the pre-registry behavior.
const SERVICE_PROVIDERS: Record<string, ServiceProvider> = {
  firebase: firebaseServiceProvider,
  sentry: sentryServiceProvider,
};

export const serviceProviders = (): ServiceProvider[] =>
  Object.values(SERVICE_PROVIDERS);

// Resolve a service provider by its manifest `provider:` name, erroring with the
// offending value when it is not registered.
export function resolveServiceProvider(provider: string): ServiceProvider {
  const impl = SERVICE_PROVIDERS[provider];
  if (!impl)
    return err(
      `Unknown service provider '${provider}' — envctl supports: ${Object.keys(SERVICE_PROVIDERS).join(", ")}`,
    );
  return impl;
}
