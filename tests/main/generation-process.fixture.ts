import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { generateProject } from "../../src/main/services/project-generation.service";
import { withArchitectureArtifactLock } from "../../src/main/services/architecture-review.service";
import { writeBatchAtomic } from "../../src/main/storage/flowweave-store";

const [mode, root, barrier, crashAt] = process.argv.slice(2);
function waitForRelease(): void {
  fs.writeFileSync(`${barrier}.ready`, String(process.pid));
  while (!fs.existsSync(`${barrier}.release`)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
if (mode === "scan") {
  const result = await generateProject(root, { onProgress: (progress) => {
    if (barrier && progress.stage === "persisting") waitForRelease();
  } });
  process.stdout.write(JSON.stringify({ status: result.status, generation: result.status === "committed" ? result.generation : undefined }));
} else if (mode === "lock") {
  await withArchitectureArtifactLock(root, async () => { waitForRelease(); });
} else if (mode === "crash") {
  const rename = fs.promises.rename;
  let replacements = 0;
  fs.promises.rename = async (source, target) => {
    await rename(source, target);
    replacements += 1;
    if (replacements === Number(crashAt)) process.kill(process.pid, "SIGKILL");
  };
  syncBuiltinESMExports();
  await withArchitectureArtifactLock(root, () => writeBatchAtomic(root, [
    { path: join(root, ".flowweave/first.json"), content: "new-first" },
    { path: join(root, ".flowweave/second.json"), content: "new-second" },
    { path: join(root, ".flowweave/generation.json"), content: JSON.stringify({ requestId: "new", inputFingerprint: "new" }) }
  ]));
}
 else if (mode === "rollback-failure" || mode === "cleanup-failure") {
  const rename = fs.promises.rename;
  const copyFile = fs.promises.copyFile;
  const rm = fs.promises.rm;
  let replacementCount = 0;
  fs.promises.rename = async (source, target) => {
    replacementCount += 1;
    if (mode === "rollback-failure" && replacementCount === 5) throw new Error("injected replacement failure");
    return rename(source, target);
  };
  fs.promises.copyFile = async (source, target, flags) => {
    fs.appendFileSync(barrier, `${String(target)}\n`);
    if (String(target).endsWith("second.json")) throw new Error("injected rollback failure");
    return copyFile(source, target, flags);
  };
  fs.promises.rm = async (path, options) => {
    if (mode === "cleanup-failure" && String(path).endsWith(".bak")) throw new Error("injected cleanup failure");
    return rm(path, options);
  };
  syncBuiltinESMExports();
  await withArchitectureArtifactLock(root, () => writeBatchAtomic(root, [
    { path: join(root, ".flowweave/first.json"), content: "new-first" },
    { path: join(root, ".flowweave/second.json"), content: "new-second" },
    { path: join(root, ".flowweave/generation.json"), content: JSON.stringify({ requestId: "new", inputFingerprint: "new" }) }
  ]));
  process.stdout.write("committed");
}
