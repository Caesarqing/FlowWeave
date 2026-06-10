import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const assetsDir = join(process.cwd(), "out", "renderer", "assets");
const files = (await readdir(assetsDir)).filter((file) => file.endsWith(".js"));
const sizes = await Promise.all(files.map(async (file) => ({ file, bytes: (await stat(join(assetsDir, file))).size })));
const entry = sizes.find((item) => item.file.startsWith("index-"));

if (!entry) {
  throw new Error(`Renderer entry JavaScript was not found in ${assetsDir}.`);
}
if (entry.bytes >= 400_000) {
  throw new Error(`Renderer entry ${entry.file} is ${entry.bytes} bytes; budget is below 400000 bytes.`);
}

for (const item of sizes.filter((candidate) => candidate.file !== entry.file && candidate.bytes > 700_000)) {
  console.warn(`Bundle warning: async chunk ${item.file} is ${item.bytes} bytes; warning threshold is 700000 bytes.`);
}
