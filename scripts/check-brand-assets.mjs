import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const requiredAssets = [
  "logo/flowweave_black_line_on_white.png",
  "logo/flowweave_white_on_black.png",
  "logo/flowweave-app-icon.png"
];
const inspectedFiles = [
  "index.html",
  "package.json",
  "src/components/BrandLogo.tsx",
  "src/main/index.ts"
];
const forbiddenReferences = ["_little.png", "logo/logo.png", "logo.svg"];

await Promise.all(requiredAssets.map(async (path) => {
  try {
    await access(join(root, path));
  } catch {
    throw new Error(`Required brand asset is missing: ${path}`);
  }
}));

for (const path of inspectedFiles) {
  const content = await readFile(join(root, path), "utf8");
  const forbidden = forbiddenReferences.find((reference) => content.includes(reference));
  if (forbidden) {
    throw new Error(`Forbidden brand asset reference "${forbidden}" found in ${path}.`);
  }
}
