import * as fs from "fs";

import { Document, isMap, isScalar, isSeq, parseDocument, YAMLSeq } from "yaml";

import { manifestFilePath } from "./parse";

function loadOrCreate(file: string): Document {
  if (!fs.existsSync(file)) return new Document({});
  const text = fs.readFileSync(file, "utf-8");
  return text.trim() === "" ? new Document({}) : parseDocument(text);
}

// Update the `environments:` list in manifest.yml, preserving comments and key
// ordering in an existing file. Uses the `yaml` Document API — the comment-safe
// replacement for the legacy js-yaml load→mutate→dump writeActiveEnvs().
//
// The sequence is rebuilt in the requested order by REUSING each surviving
// entry's node rather than replacing the whole `environments` node — so an
// inline comment on an entry (`- production # primary`) travels with it (#104).
// New names get fresh nodes; dropped names fall away. When the file does not
// exist (or is blank), a new manifest carrying only the environments list is
// created.
export function setManifestEnvironments(
  deploymentDir: string,
  environments: string[],
): void {
  const file = manifestFilePath(deploymentDir);
  const doc = loadOrCreate(file);

  // Index the surviving entries by scalar value so their nodes — and the inline
  // comments attached to them — can be reused in the rebuilt sequence.
  const current = doc.get("environments", true);
  const reusable = new Map<string, unknown>();
  if (isSeq(current)) {
    for (const item of current.items) {
      const value = isScalar(item) ? item.value : item;
      if (typeof value === "string" && !reusable.has(value))
        reusable.set(value, item);
    }
  }

  const seq = new YAMLSeq();
  for (const env of environments) {
    if (reusable.has(env)) {
      seq.items.push(reusable.get(env));
      reusable.delete(env); // never reuse the same node twice
    } else {
      seq.items.push(doc.createNode(env));
    }
  }
  doc.set("environments", seq);

  fs.writeFileSync(file, doc.toString());
}

// Persist an environment's provider target into the manifest's authoritative
// `deployments[].targets` map (#87) — the write behind `env add --target`. The
// vercel deployment entry (and its `targets` map) is created if absent;
// otherwise the single target is upserted in place, preserving comments and
// every other key. Only the target is recorded here — the active-env list stays
// in environments.yml.
export function setManifestTarget(
  deploymentDir: string,
  envName: string,
  target: string,
): void {
  const file = manifestFilePath(deploymentDir);
  const doc = loadOrCreate(file);

  const deployments = doc.get("deployments", true);
  const idx = isSeq(deployments)
    ? deployments.items.findIndex(
        (item) => isMap(item) && item.get("provider") === "vercel",
      )
    : -1;

  if (idx !== -1) {
    doc.setIn(["deployments", idx, "targets", envName], target);
  } else if (isSeq(deployments)) {
    deployments.add({ provider: "vercel", targets: { [envName]: target } });
  } else {
    doc.set("deployments", [
      { provider: "vercel", targets: { [envName]: target } },
    ]);
  }

  fs.writeFileSync(file, doc.toString());
}
