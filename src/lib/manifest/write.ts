import * as fs from "fs";

import { Document, parseDocument } from "yaml";

import { manifestFilePath } from "./parse";

// Update the `environments:` list in manifest.yml, preserving comments and key
// ordering in an existing file. This uses the `yaml` Document API — the
// comment-safe replacement for the js-yaml load→mutate→dump round-trip in the
// legacy writeActiveEnvs(), which discards comments. When the file does not
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
  doc.set("environments", environments);
  fs.writeFileSync(file, doc.toString());
}
