import type { ServiceDecl } from "./manifest/types";

// The Firebase admin credential contract — the resolved bridge between a
// project's declared `firebase` service (manifest #97/#98) and the exact Vercel
// env vars envctl reads and writes. The provider owns the credential *fields*;
// the manifest chooses the shape (#97) and maps fields → var names (#98).

/** The provider's logical credential fields. */
export type FirebaseField =
  | "serviceAccount"
  | "projectId"
  | "clientEmail"
  | "privateKey"
  | "privateKeyId";

/**
 * How many vars carry the credential in Vercel. `split` is the intended,
 * default shape; `json` is **deprecated** — retained only to read and migrate
 * projects still provisioned the old way, and slated for removal (#102).
 */
export type FirebasePatternKind = "json" | "split";

/** The default credential shape when a project declares none. */
export const DEFAULT_CREDENTIAL_PATTERN: FirebasePatternKind = "split";

/** The default var name for each field — the back-compat naming envctl assumed. */
export const DEFAULT_FIREBASE_VAR_NAMES: Record<FirebaseField, string> = {
  serviceAccount: "FIREBASE_SERVICE_ACCOUNT",
  projectId: "FIREBASE_PROJECT_ID",
  clientEmail: "FIREBASE_CLIENT_EMAIL",
  privateKey: "FIREBASE_PRIVATE_KEY",
  privateKeyId: "FIREBASE_PRIVATE_KEY_ID",
};

const ALL_FIELDS = Object.keys(DEFAULT_FIREBASE_VAR_NAMES) as FirebaseField[];

// Which fields each shape materializes as its own Vercel var: `json` carries
// everything inside the single serviceAccount blob; `split` breaks the
// credential into discrete vars (privateKeyId tracks the active key for sweeps).
const FIELDS_BY_PATTERN: Record<FirebasePatternKind, FirebaseField[]> = {
  json: ["serviceAccount"],
  split: ["projectId", "clientEmail", "privateKey", "privateKeyId"],
};

export interface FirebaseCredentialSpec {
  readonly pattern: FirebasePatternKind;
  /** Resolved var name for every field (declared override ?? default). */
  readonly names: Readonly<Record<FirebaseField, string>>;
}

/**
 * Resolve a `firebase` service declaration into a concrete credential contract.
 * A missing declaration (or missing fields) falls back to the default: the
 * `split` shape with the default names. Declaring `credential: json` opts into
 * the deprecated shape (see {@link isDeprecatedCredential}).
 *
 * Throws if any override value is empty or if two fields resolve to the same
 * var name — both produce unusable Vercel credentials.
 */
export function resolveFirebaseCredential(
  service?: ServiceDecl,
): FirebaseCredentialSpec {
  const pattern: FirebasePatternKind =
    service?.credential ?? DEFAULT_CREDENTIAL_PATTERN;
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

  return { pattern, names };
}

/**
 * Whether a service explicitly opts into the deprecated `json` credential shape
 * — worth a deprecation warning at the command boundary. Slated for removal in
 * #102.
 */
export function isDeprecatedCredential(service?: ServiceDecl): boolean {
  return service?.credential === "json";
}

/** The var names a shape writes to Vercel. */
export function patternVarNames(
  names: FirebaseCredentialSpec["names"],
  pattern: FirebasePatternKind,
): string[] {
  return FIELDS_BY_PATTERN[pattern].map((field) => names[field]);
}

/**
 * Keys whose presence in Vercel means Firebase is provisioned under the
 * declared contract. Uses only the resolved names so the presence check is
 * consistent with what {@link detectExistingPattern} can find — advertising
 * legacy default names for a custom-named contract would cause
 * `rotation.run` to detect Firebase as present but then fail inside
 * `rotateFirebase` when the legacy var can't be resolved via the custom names.
 */
export function firebasePresenceKeys(spec: FirebaseCredentialSpec): string[] {
  return [spec.names.serviceAccount, spec.names.privateKey];
}
