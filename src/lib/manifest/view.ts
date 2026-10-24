import * as fs from "fs";
import * as path from "path";

import { parse } from "yaml";

import { asStringArray, isRecord, parseDeployments } from "./parse-fields";
import type { DeploymentDecl } from "./types";

// A deployment view (#213): `deployment/<name>/` with no config of its own
// resolves as the parent manifest's deployment named `<name>`. Every command
// reads config by directory, so a view lets them act on one deployment of a
// multi-deployment root manifest unchanged.
//
// This module reads the root manifest directly instead of through
// parseManifest, so the low-level env readers in environments.ts can depend
// on it without an import cycle.

export interface DeploymentView {
  /** The directory holding the root manifest.yml. */
  readonly root: string;
  readonly deployment: DeploymentDecl;
  /** How many other deployments the root manifest declares. */
  readonly siblings: number;
  /** The root manifest's declared environments. */
  readonly rootEnvironments: readonly string[];
}

const MANIFEST = "manifest.yml";

// A deployment's name is a path segment (`<deployment-dir>/<name>`), so it
// must not traverse or nest.
export function isSafeDeploymentName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

// The parsed YAML, or undefined when it doesn't parse. The parent of a
// deployment dir can hold an unrelated manifest.yml (the repo root's, say), so
// a parse error there means "not a view" rather than a crash; a broken envctl
// root manifest still fails loudly when parsed as itself.
function readYaml(file: string): unknown {
  const content = fs.readFileSync(file, "utf-8");
  if (content.trim() === "") return {};
  try {
    return parse(content);
  } catch {
    return undefined;
  }
}

// The view `dir` resolves to, or undefined when it holds its own config (a
// manifest.yml or legacy environments.yml) or the parent declares no
// deployment by its name.
export function deploymentView(dir: string): DeploymentView | undefined {
  if (
    fs.existsSync(path.join(dir, MANIFEST)) ||
    fs.existsSync(path.join(dir, "environments.yml"))
  )
    return undefined;
  const resolved = path.resolve(dir);
  const root = path.dirname(resolved);
  const file = path.join(root, MANIFEST);
  if (!fs.existsSync(file)) return undefined;
  const raw = readYaml(file);
  if (!isRecord(raw)) return undefined;
  const name = path.basename(resolved);
  const deployments = parseDeployments(raw.deployments);
  const deployment = deployments.find((d) => d.name === name);
  if (!deployment) return undefined;
  return {
    root,
    deployment,
    siblings: deployments.length - 1,
    rootEnvironments:
      raw.environments !== undefined
        ? asStringArray(raw.environments)
        : legacyActiveEnvs(root),
  };
}

// The root's environments.yml `active:` list, for a root manifest that has no
// `environments` key yet (mirrors parseManifest's hybrid-state fallback).
function legacyActiveEnvs(root: string): string[] {
  const file = path.join(root, "environments.yml");
  if (!fs.existsSync(file)) return [];
  const data = readYaml(file);
  return isRecord(data) ? asStringArray(data.active) : [];
}

// The environments a view deploys: its own scope, else the root's.
export function viewEnvironments(view: DeploymentView): readonly string[] {
  return view.deployment.environments ?? view.rootEnvironments;
}
