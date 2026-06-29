import * as fs from "fs";
import * as path from "path";

export function makeDeploymentDir(
  tmpDir: string,
  active: string[],
  envVars: Record<string, Record<string, string>>,
): string {
  const deployDir = path.join(tmpDir, "deployment");
  fs.mkdirSync(deployDir);
  fs.writeFileSync(
    path.join(deployDir, "environments.yml"),
    `active:\n${active.map((e) => `  - ${e}`).join("\n")}\n`,
  );
  for (const [envName, vars] of Object.entries(envVars)) {
    const lines = Object.entries(vars)
      .map(([k, v]) => `${k}: "${v}"`)
      .join("\n");
    fs.writeFileSync(path.join(deployDir, `${envName}.yml`), lines + "\n");
  }
  return deployDir;
}
