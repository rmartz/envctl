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

/** How many vars carry the credential in Vercel. */
export type FirebasePatternKind = "json" | "split";

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
 * A missing declaration (or missing fields) falls back to the provider default:
 * the `json` shape with the hardcoded default names, so existing projects are
 * unchanged.
 */
export function resolveFirebaseCredential(
  service?: ServiceDecl,
): FirebaseCredentialSpec {
  const pattern: FirebasePatternKind = service?.credential ?? "json";
  const overrides = service?.variables ?? {};
  const names = {} as Record<FirebaseField, string>;
  for (const field of ALL_FIELDS)
    names[field] = overrides[field] ?? DEFAULT_FIREBASE_VAR_NAMES[field];
  return { pattern, names };
}

const unique = (values: string[]): string[] => [...new Set(values)];

/** The var names a shape writes to Vercel. */
export function patternVarNames(
  names: FirebaseCredentialSpec["names"],
  pattern: FirebasePatternKind,
): string[] {
  return FIELDS_BY_PATTERN[pattern].map((field) => names[field]);
}

/**
 * Keys whose presence in Vercel means Firebase is provisioned. Covers the
 * declared shape's primary key vars *and* the default names, so a project on
 * defaults, on custom names, or mid-migration is all still detected.
 */
export function firebasePresenceKeys(spec: FirebaseCredentialSpec): string[] {
  return unique([
    spec.names.serviceAccount,
    spec.names.privateKey,
    DEFAULT_FIREBASE_VAR_NAMES.serviceAccount,
    DEFAULT_FIREBASE_VAR_NAMES.privateKey,
  ]);
}
