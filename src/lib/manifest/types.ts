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
  /** Unique within the manifest; defaults to `provider` (#211). */
  readonly name: string;
  readonly provider: string;
  /** Environments this service is scoped to; `undefined` ⇒ every environment. */
  readonly environments?: readonly string[];
  /**
   * Maps each provider credential *field* to the exact env var name the app
   * reads (#98), e.g. `{ privateKey: "FB_PRIVATE_KEY" }`. Fields left out fall
   * back to the provider's default name; an empty/absent map ⇒ all defaults.
   */
  readonly variables?: Readonly<Record<string, string>>;
  /** `github-app` only (#201): the URL the App's webhook is pointed at. */
  readonly webhookUrl?: string;
}

/**
 * A named, provider-typed deployment sink (vercel, …): one provider project,
 * its env→target mapping, and which services and variables reach it (#210).
 */
export interface DeploymentDecl {
  /** Unique within the manifest; defaults to `provider` (#211). */
  readonly name: string;
  readonly provider: string;
  /** Names of the services that reach it; `undefined` ⇒ every service. */
  readonly services?: readonly string[];
  /** Environments it deploys; `undefined` ⇒ every declared environment. */
  readonly environments?: readonly string[];
  /** Variables only this deployment receives, on top of the top-level ones. */
  readonly variables?: readonly VariableDecl[];
  /** deploy-environment name → provider infrastructure target. */
  readonly targets: Readonly<Record<string, string>>;
  /**
   * The provider project this deployment dir is pinned to (#208). When set it
   * wins over `.vercel/project.json` and `VERCEL_PROJECT_ID`, and either of
   * those naming a different project is refused.
   */
  readonly projectId?: string;
  /** The pinned project's team (owner); unset ⇒ resolved as before. */
  readonly teamId?: string;
}

/**
 * A deployed variable mirrored to a GitHub Actions secret (#198): whenever
 * envctl pushes `variable` to `environment`'s target, it also writes the value
 * to the secret `name` (default: the variable name).
 */
export interface GithubSecretDecl {
  readonly variable: string;
  readonly environment: string;
  readonly name?: string;
  /** GitHub Actions environment to scope the secret to; unset ⇒ repository. */
  readonly githubEnvironment?: string;
}

/** The secondary GitHub Actions secret sink. */
export interface GithubDecl {
  /** `owner/name`; unset ⇒ gh resolves the repo from the working directory. */
  readonly repo?: string;
  readonly secrets: readonly GithubSecretDecl[];
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
  /** GitHub Actions secrets to mirror pushed values to; unset ⇒ none. */
  readonly github?: GithubDecl;
}

export type Visibility = "public" | "secret";

/** A literal `value` is public; every other source is a secret. */
export function variableVisibility(source: VariableSource): Visibility {
  return source.kind === "value" ? "public" : "secret";
}
