/* Runs every tests/*.test.mjs in this one process (so it works where `node --test` can't spawn
   child processes). Run: npm test */
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = fileURLToPath(new URL("./", import.meta.url));
for (const file of readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort()) {
  await import(pathToFileURL(dir + file).href);
}
