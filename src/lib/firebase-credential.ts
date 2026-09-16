import type { ServiceDecl } from "./manifest/types";

// The Firebase admin credential contract — the resolved bridge between a
// project's declared `firebase` service (manifest #98) and the exact Vercel env
// vars envctl reads and writes. The provider owns the credential *fields*; the
// manifest maps fields → var names (#98). The credential is always the discrete
// `split` shape (the deprecated single-blob `json` shape was removed in #102).

/** The provider's logical credential fields. */
export type FirebaseField =
  "projectId" | "clientEmail" | "privateKey" | "privateKeyId";

/** The default var name for each field — the back-compat naming envctl assumed. */
export const DEFAULT_FIREBASE_VAR_NAMES: Record<FirebaseField, string> = {
  projectId: "FIREBASE_PROJECT_ID",
  clientEmail: "FIREBASE_CLIENT_EMAIL",
  privateKey: "FIREBASE_PRIVATE_KEY",
  privateKeyId: "FIREBASE_PRIVATE_KEY_ID",
};

const ALL_FIELDS = Object.keys(DEFAULT_FIREBASE_VAR_NAMES) as FirebaseField[];

export interface FirebaseCredentialSpec {
  /** Resolved var name for every field (declared override ?? default). */
  readonly names: Readonly<Record<FirebaseField, string>>;
}

/**
 * Resolve a `firebase` service declaration into a concrete credential contract:
 * the resolved var name for every field. A missing declaration (or missing
 * fields) falls back to the default names.
 *
 * Throws if any override value is empty or if two fields resolve to the same
 * var name — both produce unusable Vercel credentials.
 */
export function resolveFirebaseCredential(
  service?: ServiceDecl,
): FirebaseCredentialSpec {
  const overrides = service?.variables ?? {};

  for (const [field, name] of Object.entries(overrides)) {
    if (!name || !name.trim())
      throw new Error(
        `Firebase credential override for '${field}' must not be empty`,
      );
  }

  const names = {} as Record<FirebaseField, string>;
  for (const field of ALL_FIELDS)
    names[field] = overrides[field] ?? DEFAULT_FIREBASE_VAR_NAMES[field];

  const seen = new Set<string>();
  for (const [field, name] of Object.entries(names) as [
    FirebaseField,
    string,
  ][]) {
    if (seen.has(name))
      throw new Error(
        `Firebase credential var names must be unique; '${name}' is mapped to multiple fields (including '${field}')`,
      );
    seen.add(name);
  }

  return { names };
}

/**
 * Keys whose presence in Vercel means Firebase is provisioned under the
 * declared contract. Uses only the resolved names so the presence check is
 * consistent with what the readers ({@link firebase-vars}) look for —
 * advertising a legacy default name for a custom-named contract would cause
 * `rotation.run` to detect Firebase as present but then fail inside
 * `rotateFirebase` when the custom var can't be resolved.
 */
export function firebasePresenceKeys(spec: FirebaseCredentialSpec): string[] {
  return [spec.names.privateKey];
}
