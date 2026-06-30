import * as path from "path";

const scriptName = process.argv[1]
  ? path.basename(process.argv[1], ".js")
  : "vercel-scripts";

export class FatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalError";
  }
}

export const log = (msg: string) => {
  console.log(`[${scriptName}] ${msg}`);
};
export const warn = (msg: string) => {
  console.error(`[${scriptName}] WARNING: ${msg}`);
};
export const err = (msg: string): never => {
  throw new FatalError(msg);
};
