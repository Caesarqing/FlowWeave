import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

const rendererRoot = join(process.cwd(), "out", "renderer");
const html = await readFile(join(rendererRoot, "index.html"), "utf8");
const entryMatch = html.match(/<script[^>]+src="\.\/assets\/([^"]+\.js)"/);
if (!entryMatch) {
  throw new Error("Could not identify the renderer entry bundle from out/renderer/index.html.");
}

const assetsRoot = join(rendererRoot, "assets");
const entryName = basename(entryMatch[1]);
const files = (await readdir(assetsRoot)).filter((file) => file.endsWith(".js"));
const sizes = await Promise.all(files.map(async (file) => ({ file, bytes: (await stat(join(assetsRoot, file))).size })));
const entry = sizes.find((item) => item.file === entryName);
if (!entry) throw new Error(`Renderer entry bundle was not found: ${entryName}.`);

const ENTRY_LIMIT = 400 * 1024;
const ASYNC_WARNING_LIMIT = 700 * 1024;
if (entry.bytes > ENTRY_LIMIT) {
  throw new Error(`Renderer entry ${entry.file} is ${formatSize(entry.bytes)}; limit is ${formatSize(ENTRY_LIMIT)}.`);
}
for (const item of sizes) {
  if (item.file !== entry.file && item.bytes > ASYNC_WARNING_LIMIT) {
    process.stderr.write(`Bundle warning: ${item.file} is ${formatSize(item.bytes)}; target is at most ${formatSize(ASYNC_WARNING_LIMIT)}.\n`);
  }
}
process.stdout.write(`Bundle check passed: entry ${entry.file} is ${formatSize(entry.bytes)}.\n`);

function formatSize(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}
