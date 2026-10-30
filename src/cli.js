import { readFileSync } from "node:fs";

// Placeholder until the CLI is implemented.
const args = process.argv.slice(2);
if (args[0] === "--version") {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  console.log(pkg.version);
} else {
  console.log(`Usage:
  sketchboard open <canvas>
  sketchboard wait [<canvas>] [--timeout <s>]
  sketchboard status
  sketchboard stop
  sketchboard shot <canvas> <board>
  sketchboard --version`);
}
