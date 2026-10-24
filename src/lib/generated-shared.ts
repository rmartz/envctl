import * as path from "path";

import {
  generateSecretValue,
  resolveGeneratedSecrets,
  type GeneratedSecret,
  type GeneratedSecretPushOptions,
} from "./generated-secrets";
import { err, log } from "./logger";
import { deploymentView, parseManifest, type DeploymentDecl } from "./manifest";
import type { DeploymentProvider } from "./providers/deployment";
import { resolveProjectDeployment } from "./providers/registry";

// Generated variables shared across deployments (#219). A `generate: true`
// variable declared at the top level of a multi-deployment manifest (or in a
// root variable group) reaches every deployment, so it has one value per
// target across all of them. One declared under a deployment stays its own.

// One deployment's side of a shared push: its provider and its own resolved
// generated secrets (targets can differ between deployments).
export interface SharedGeneratedMember {
  readonly name: string;
  readonly deployment: DeploymentProvider;
  readonly secrets: readonly GeneratedSecret[];
}

// Split a run's generated secrets into those it owns and those shared with
// sibling deployments, with every sibling resolved (identity pin-checked) when
// any are shared. `primary` is the run's own provider; it stays first.
export function splitSharedGenerated(
  deploymentDir: string,
  workingDir: string,
  primary: DeploymentProvider,
  generated: GeneratedSecret[],
): {
  own: GeneratedSecret[];
  shared: string[];
  members: SharedGeneratedMember[];
} {
  const view = deploymentView(deploymentDir);
  if (!view || view.siblings === 0)
    return { own: generated, shared: [], members: [] };
  const root = parseManifest(view.root);
  const rootGenerated = new Set(
    [...root.variables, ...root.variableGroups.flatMap((g) => g.variables)]
      .filter((v) => v.source.kind === "generate")
      .map((v) => v.name),
  );
  // A deployment that declares a root variable under its own `variables`
  // overrides it, so the name is its own there, not shared.
  const overrides = (d: DeploymentDecl): Set<string> =>
    new Set((d.variables ?? []).map((v) => v.name));
  const isShared = (name: string, d: DeploymentDecl): boolean =>
    rootGenerated.has(name) && !overrides(d).has(name);
  const shared = generated
    .map((s) => s.name)
    .filter((name) => isShared(name, view.deployment));
  if (shared.length === 0) return { own: generated, shared, members: [] };
  const members = root.deployments.map((d) => {
    const dir = path.join(view.root, d.name);
    return {
      name: d.name,
      deployment:
        d.name === view.deployment.name
          ? primary
          : resolveProjectDeployment(dir, workingDir),
      secrets: resolveGeneratedSecrets(dir).filter((s) => isShared(s.name, d)),
    };
  });
  members.sort((a, b) =>
    a.name === view.deployment.name
      ? -1
      : b.name === view.deployment.name
        ? 1
        : 0,
  );
  return {
    own: generated.filter((s) => !shared.includes(s.name)),
    shared,
    members,
  };
}

// The value a deployment already holds, to copy to its siblings. An unreadable
// (e.g. sensitive) value can't be copied, and minting a new one would leave the
// holder out of step, so it is refused.
async function readHeld(
  member: SharedGeneratedMember,
  id: string,
  name: string,
  target: string,
): Promise<string> {
  const value = await member.deployment.getEnvVarValue(id);
  if (value) return value;
  return err(
    `Can't read the shared generated secret ${name} [${target}] from deployment '${member.name}' to copy it to the others. Rotate it instead (\`secrets rotate\`), which writes one new value to every deployment.`,
  );
}

// Push shared generated secrets so every deployment holds the same value per
// target. On init, a value any deployment already holds is copied to those
// lacking it, else one is minted; on rotate, one fresh value is written to all.
// Returns the names of the deployments written to, so each can be redeployed.
export async function pushSharedGeneratedSecrets(
  members: readonly SharedGeneratedMember[],
  names: readonly string[],
  opts: GeneratedSecretPushOptions,
): Promise<Set<string>> {
  const written = new Set<string>();
  for (const name of names) {
    const targets = new Set(
      members.flatMap(
        (m) => m.secrets.find((s) => s.name === name)?.targets ?? [],
      ),
    );
    for (const target of targets) {
      if (opts.targetEnv !== "all" && target !== opts.targetEnv) continue;
      const scoped = members.filter((m) =>
        m.secrets.some((s) => s.name === name && s.targets.includes(target)),
      );
      const held = await Promise.all(
        scoped.map(async (m) => {
          const { envs } = await m.deployment.listEnvVars();
          return {
            m,
            envs,
            record: m.deployment.findEnvVar(envs, name, target),
          };
        }),
      );
      const holder = held.find((h) => h.record !== undefined);
      const value =
        !opts.overwrite && holder?.record
          ? await readHeld(holder.m, holder.record.id, name, target)
          : generateSecretValue();
      for (const { m, envs, record } of held) {
        if (record && !opts.overwrite) continue;
        await m.deployment.setEnvForTarget(
          name,
          value,
          target,
          envs,
          "encrypted",
        );
        log(
          `  [${m.name}/${target}] ${record ? "Rotated" : holder ? "Copied" : "Minted"} shared generated secret ${name}`,
        );
        written.add(m.name);
      }
    }
  }
  return written;
}
