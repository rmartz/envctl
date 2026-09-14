import * as fs from "fs";

import { Document, isScalar, isSeq, parseDocument, YAMLSeq } from "yaml";

import { manifestFilePath } from "./parse";

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
  let doc: Document;
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf-8");
    doc = text.trim() === "" ? new Document({}) : parseDocument(text);
  } else {
    doc = new Document({});
  }

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
