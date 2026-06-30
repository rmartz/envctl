import * as fs from "fs";
import * as path from "path";

// Walks up from `fromDir` to the nearest package.json and returns its version.
// Works both when running compiled (dist/envctl.js → repo root) and under
// Vitest (src/lib/cli → repo root), since neither layout has an intervening
// package.json. Throws a plain Error if none is found.
export function readPackageVersion(fromDir: string): string {
  let dir = fromDir;
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
        version?: string;
      };
      return pkg.version ?? "0.0.0";
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`package.json not found above ${fromDir}`);
    }
    dir = parent;
  }
}
