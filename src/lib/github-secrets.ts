import { mkError, mkWarning, type Finding } from "./check";
import { log } from "./logger";
import { parseManifest } from "./manifest";
import type { DeploymentProvider } from "./providers/deployment";
import { run as runCmd } from "./subprocess";
import { envTargetResolver } from "./targets";

// GitHub Actions secrets as a secondary sink (#198). A project declares which
// deployed variables CI also needs; whenever envctl pushes one of them to its
// declared target, the same value is written to the GitHub secret. Mirroring at
// push time means the GitHub write lands before the redeploy and invalidation,
// and a failed write aborts the run while the old credential is still valid.

export interface GithubSecretTarget {
  variable: string;
  /** The provider target whose pushed value is mirrored. */
  target: string;
  secretName: string;
  githubEnvironment: string | undefined;
  /** `owner/name`; undefined ⇒ gh resolves it from the working directory. */
  repo: string | undefined;
}

// Resolve the manifest's `github.secrets` into concrete (variable, target) →
// secret mappings. A project with no `github` block yields an empty list.
export function resolveGithubSecrets(
  deploymentDir: string,
): GithubSecretTarget[] {
  const github = parseManifest(deploymentDir).github;
  if (!github) return [];
  const resolveTarget = envTargetResolver(deploymentDir);
  return github.secrets.map((s) => ({
    variable: s.variable,
    target: resolveTarget(s.environment),
    secretName: s.name ?? s.variable,
    githubEnvironment: s.githubEnvironment,
    repo: github.repo,
  }));
}

const scopeArgs = (t: GithubSecretTarget): string[] => [
  ...(t.repo ? ["--repo", t.repo] : []),
  ...(t.githubEnvironment ? ["--env", t.githubEnvironment] : []),
];

const describeTarget = (t: GithubSecretTarget): string =>
  `${t.repo ?? "current repo"}${t.githubEnvironment ? ` (env: ${t.githubEnvironment})` : ""}`;

// Write one secret through `gh secret set`, passing the value on stdin so it
// never appears in the process list. gh handles the sealed-box encryption.
function setGithubSecret(t: GithubSecretTarget, value: string): void {
  try {
    runCmd("gh", ["secret", "set", t.secretName, ...scopeArgs(t)], {
      input: value,
    });
  } catch (e) {
    throw new Error(
      `Failed to write GitHub secret ${t.secretName} to ${describeTarget(t)}: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
  log(`  [github] Updated ${t.secretName} in ${describeTarget(t)}`);
}

// Wrap a deployment provider so every `setEnvForTarget` — the path all secret
// writes take — is also mirrored to the matching GitHub secrets. The deployment
// write happens first; GitHub is a secondary copy.
export function withGithubSecretSync(
  deployment: DeploymentProvider,
  targets: GithubSecretTarget[],
): DeploymentProvider {
  if (targets.length === 0) return deployment;
  return {
    provider: deployment.provider,
    projectId: deployment.projectId,
    teamId: deployment.teamId,
    listEnvVars: () => deployment.listEnvVars(),
    getEnvVarValue: (id) => deployment.getEnvVarValue(id),
    findEnvVar: (envs, key, target) => deployment.findEnvVar(envs, key, target),
    createEnvVar: (key, value, target, type) =>
      deployment.createEnvVar(key, value, target, type),
    updateEnvVar: (existing, value) => deployment.updateEnvVar(existing, value),
    setEnvForTarget: async (key, value, target, envs, type) => {
      const id = await deployment.setEnvForTarget(
        key,
        value,
        target,
        envs,
        type,
      );
      for (const t of targets)
        if (t.variable === key && t.target === target)
          setGithubSecret(t, value);
      return id;
    },
    removeEnvVarFromTarget: (id, existingTargets, vercelEnv) =>
      deployment.removeEnvVarFromTarget(id, existingTargets, vercelEnv),
    triggerAndWaitRedeployments: (targetEnv) =>
      deployment.triggerAndWaitRedeployments(targetEnv),
    refreshPreviewDeployments: () => deployment.refreshPreviewDeployments(),
  };
}

// Log which GitHub secrets this run will update, so the plan is visible
// before anything is minted.
export function logGithubPlan(targets: GithubSecretTarget[]): void {
  for (const t of targets)
    log(
      `GitHub: ${t.variable} [${t.target}] → ${t.secretName} in ${describeTarget(t)}`,
    );
}

// `check --live`: every declared secret must exist in its repo/environment.
// Values are write-only, so only presence can be checked. A scope whose secrets
// cannot be listed (gh missing, no access) is a warning, not a missing secret.
export function checkGithubSecrets(targets: GithubSecretTarget[]): Finding[] {
  const findings: Finding[] = [];
  const scopes = new Map<string, GithubSecretTarget[]>();
  for (const t of targets) {
    const key = scopeArgs(t).join(" ");
    scopes.set(key, [...(scopes.get(key) ?? []), t]);
  }
  for (const group of scopes.values()) {
    let names: Set<string>;
    try {
      const listed = JSON.parse(
        runCmd("gh", [
          "secret",
          "list",
          ...scopeArgs(group[0]),
          "--json",
          "name",
        ]),
      ) as { name: string }[];
      names = new Set(listed.map((s) => s.name));
    } catch (e) {
      findings.push(
        mkWarning(
          `GitHub secrets in ${describeTarget(group[0])} could not be listed: ${e instanceof Error ? e.message : String(e)}`,
          { kind: "github-unavailable" },
        ),
      );
      continue;
    }
    for (const t of group)
      if (!names.has(t.secretName))
        findings.push(
          mkError(
            `GitHub secret ${t.secretName} (mirroring ${t.variable}) is missing from ${describeTarget(t)}`,
            { kind: "github-missing", target: t.target, key: t.secretName },
          ),
        );
  }
  return findings;
}
