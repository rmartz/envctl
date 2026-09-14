// The resolved deployment-manifest model. A single `manifest.yml` declares
// STRUCTURE, SOURCES, and SCOPES env-agnostically; per-environment overlay
// files carry only literal value overrides. This is the typed foundation the
// config-manifest epic (#84) builds on — no command reads it yet.

/**
 * Where a variable's value comes from. Visibility is *derived* from the source
 * (see {@link variableVisibility}) rather than tracked as a separate flag: a
 * literal `value` lives in git and is public; everything else is a secret.
 */
export type VariableSource =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "generate" };

export interface VariableDecl {
  readonly name: string;
  readonly source: VariableSource;
}

/** A provider-typed source of secret variables + rotation (firebase, sentry). */
export interface ServiceDecl {
  readonly provider: string;
  /** Environments this service is scoped to; `undefined` ⇒ every environment. */
  readonly environments?: readonly string[];
  /**
   * Firebase credential shape — how many vars carry the admin credential (#97).
   * `split` (the default) = the discrete projectId/clientEmail/privateKey/
   * privateKeyId vars; `json` = one `FIREBASE_SERVICE_ACCOUNT` blob and is
   * **deprecated**, retained only to migrate existing projects (removal: #102).
   * Ignored by other providers.
   */
  readonly credential?: "split" | "json";
  /**
   * Maps each provider credential *field* to the exact env var name the app
   * reads (#98), e.g. `{ privateKey: "FB_PRIVATE_KEY" }`. Fields left out fall
   * back to the provider's default name; an empty/absent map ⇒ all defaults.
   */
  readonly variables?: Readonly<Record<string, string>>;
}

/** A provider-typed deployment sink (vercel, …) with its env→target mapping. */
export interface DeploymentDecl {
  readonly provider: string;
  /** deploy-environment name → provider infrastructure target. */
  readonly targets: Readonly<Record<string, string>>;
}

/** A scoped bundle of project-owned variables. */
export interface VariableGroup {
  readonly name: string;
  /** Environments this group applies to; `undefined` ⇒ every environment. */
  readonly environments?: readonly string[];
  readonly variables: readonly VariableDecl[];
}

export interface ResolvedManifest {
  readonly environments: readonly string[];
  readonly deployments: readonly DeploymentDecl[];
  readonly services: readonly ServiceDecl[];
  /** Top-level (ungrouped) variables — apply to every environment. */
  readonly variables: readonly VariableDecl[];
  readonly variableGroups: readonly VariableGroup[];
  /**
   * Literal value overrides from per-environment overlay files:
   * env name → { variable name → literal value }.
   */
  readonly overlays: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export type Visibility = "public" | "secret";

/** A literal `value` is public; every other source is a secret. */
export function variableVisibility(source: VariableSource): Visibility {
  return source.kind === "value" ? "public" : "secret";
}
