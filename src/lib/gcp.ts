import { run as runCmd } from "./subprocess";

// ─── GCP helpers ──────────────────────────────────────────────────────────────

export function createGcpKey(
  outputFile: string,
  saEmail: string,
  gcpProject: string,
): void {
  runCmd("gcloud", [
    "iam",
    "service-accounts",
    "keys",
    "create",
    outputFile,
    "--iam-account",
    saEmail,
    "--project",
    gcpProject,
    "--quiet",
  ]);
}

export function listUserManagedGcpKeys(
  saEmail: string,
  gcpProject: string,
): string[] {
  const output = runCmd("gcloud", [
    "iam",
    "service-accounts",
    "keys",
    "list",
    "--iam-account",
    saEmail,
    "--project",
    gcpProject,
    "--managed-by",
    "user",
    "--format",
    "value(name.basename())",
  ]);
  return output.trim().split("\n").filter(Boolean);
}

export function deleteGcpKey(
  keyId: string,
  saEmail: string,
  gcpProject: string,
): void {
  runCmd("gcloud", [
    "iam",
    "service-accounts",
    "keys",
    "delete",
    keyId,
    "--iam-account",
    saEmail,
    "--project",
    gcpProject,
    "--quiet",
  ]);
}
