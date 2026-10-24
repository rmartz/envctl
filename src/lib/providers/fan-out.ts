import { FatalError, log } from "../logger";
import type { VercelEnvVar } from "../vercel-api";
import type { DeploymentProvider } from "./deployment";

// One deployment of a shared-service run (#216): its manifest name, for the
// partial-state report, and its own provider (identity already pin-checked).
export interface FanOutMember {
  readonly name: string;
  readonly deployment: DeploymentProvider;
}

// The record for `key` on `target` in a member's own listing, if any.
async function ownRecord(
  member: FanOutMember,
  key: string,
  target: string,
): Promise<VercelEnvVar | undefined> {
  const { envs } = await member.deployment.listEnvVars();
  return member.deployment.findEnvVar(envs, key, target);
}

// Write the updated `record`'s new value on each of its targets in a member's
// project, through its own records (ids differ between projects), keeping the
// record's type. The legacy "secret" type can't be written, so it becomes
// "encrypted".
async function writeOwn(
  member: FanOutMember,
  record: VercelEnvVar,
  value: string,
): Promise<void> {
  const type = record.type === "secret" ? "encrypted" : record.type;
  for (const target of record.target) {
    const { envs } = await member.deployment.listEnvVars();
    await member.deployment.setEnvForTarget(
      record.key,
      value,
      target,
      envs,
      type,
    );
  }
}

// A deployment provider over every project that shares a service (#216). Reads
// come from the primary, so a service provider sees one current credential and
// mints one replacement; every write is repeated on each other project through
// its own records. Redeploys run in order and stop at the first failure, which
// throws before the engine activates or invalidates anything: the new
// credential is on every project and the old one stays valid.
export function fanOutDeployment(
  primary: FanOutMember,
  others: readonly FanOutMember[],
): DeploymentProvider {
  const p = primary.deployment;
  const members = [primary, ...others];
  return {
    provider: p.provider,
    projectId: p.projectId,
    teamId: p.teamId,
    listEnvVars: () => p.listEnvVars(),
    getEnvVarValue: (id) => p.getEnvVarValue(id),
    findEnvVar: (envs, key, target) => p.findEnvVar(envs, key, target),
    createEnvVar: async (key, value, target, type) => {
      const created = await p.createEnvVar(key, value, target, type);
      for (const o of others)
        await o.deployment.createEnvVar(key, value, target, type);
      return created;
    },
    updateEnvVar: async (existing, value) => {
      await p.updateEnvVar(existing, value);
      for (const o of others) await writeOwn(o, existing, value);
    },
    setEnvForTarget: async (key, value, target, envs, type) => {
      const id = await p.setEnvForTarget(key, value, target, envs, type);
      for (const o of others) {
        const own = await o.deployment.listEnvVars();
        await o.deployment.setEnvForTarget(key, value, target, own.envs, type);
      }
      return id;
    },
    removeEnvVarFromTarget: async (id, existingTargets, vercelEnv) => {
      const key = (await p.listEnvVars()).envs.find((e) => e.id === id)?.key;
      await p.removeEnvVarFromTarget(id, existingTargets, vercelEnv);
      if (key === undefined) return;
      for (const o of others) {
        const record = await ownRecord(o, key, vercelEnv);
        if (record)
          await o.deployment.removeEnvVarFromTarget(
            record.id,
            record.target,
            vercelEnv,
          );
      }
    },
    triggerAndWaitRedeployments: async (targetEnv) => {
      const done: string[] = [];
      for (const member of members) {
        log(`Redeploying deployment '${member.name}'...`);
        try {
          await member.deployment.triggerAndWaitRedeployments(targetEnv);
        } catch (e) {
          const pending = members
            .map((m) => m.name)
            .filter((n) => n !== member.name && !done.includes(n));
          throw new FatalError(
            `Redeploy failed for deployment '${member.name}': ${e instanceof Error ? e.message : String(e)}\n` +
              `  Every deployment (${members.map((m) => m.name).join(", ")}) already holds the new credential; nothing was invalidated, so the old one stays valid.\n` +
              `  Redeployed: ${done.join(", ") || "none"}. Still to redeploy: ${[member.name, ...pending].join(", ")}.\n` +
              `  Redeploy those, then rerun the rotation to retire the old credential.`,
          );
        }
        done.push(member.name);
      }
    },
    refreshPreviewDeployments: async () => {
      for (const member of members)
        await member.deployment.refreshPreviewDeployments();
    },
  };
}
