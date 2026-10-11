import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

type AuthorityRecord = {
  version: 1;
  projectRoot: string;
  transactionId: string;
  journalSha256: string;
};

let configuredRoot: string | undefined;

export function configureTransactionAuthorityRoot(userDataPath: string): void {
  if (!isAbsolute(userDataPath)) throw new TypeError(`Transaction authority root must be absolute: ${userDataPath}`);
  configuredRoot = resolve(userDataPath);
}

export function getTransactionAuthorityRoot(): string {
  if (!configuredRoot) throw new Error("Transaction authority root has not been configured.");
  return configuredRoot;
}

export async function writeTransactionAuthority(projectRoot: string, transactionId: string, journalText: string): Promise<void> {
  const directory = authorityDirectory(projectRoot);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertRegularDirectory(directory);
  const record: AuthorityRecord = { version: 1, projectRoot, transactionId, journalSha256: digest(journalText) };
  const path = join(directory, `${transactionId}.json`);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(record), "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  await syncDirectory(directory);
}

export async function verifyTransactionAuthority(projectRoot: string, transactionId: string, journalText: string): Promise<boolean> {
  const path = join(authorityDirectory(projectRoot), `${transactionId}.json`);
  let content: string;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Transaction authority is not a regular file: ${path}`);
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingPath(error)) throw new Error(`Transaction authority record is missing: ${path}`, { cause: error });
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(content); }
  catch (error) { throw new Error(`Transaction authority record is malformed: ${path}`, { cause: error }); }
  if (!isAuthorityRecord(value) || value.projectRoot !== projectRoot || value.transactionId !== transactionId ||
    value.journalSha256 !== digest(journalText)) {
    throw new Error(`Transaction authority record does not match the project journal: ${path}`);
  }
  const cleanupPath = join(authorityDirectory(projectRoot), `${transactionId}.cleanup`);
  try {
    const info = await lstat(cleanupPath);
    if (!info.isFile() || info.isSymbolicLink() || await readFile(cleanupPath, "utf8") !== digest(journalText)) {
      throw new Error(`Transaction cleanup record does not match the project journal: ${cleanupPath}`);
    }
    return true;
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

export async function markTransactionCleanupStarted(projectRoot: string, transactionId: string, journalText: string): Promise<void> {
  if (await verifyTransactionAuthority(projectRoot, transactionId, journalText)) return;
  const directory = authorityDirectory(projectRoot);
  const cleanupPath = join(directory, `${transactionId}.cleanup`);
  const temporaryPath = join(directory, `${transactionId}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(digest(journalText), "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporaryPath, cleanupPath);
  await syncDirectory(directory);
}

export async function removeTransactionAuthority(projectRoot: string, transactionId: string): Promise<void> {
  const directory = authorityDirectory(projectRoot);
  await rm(join(directory, `${transactionId}.cleanup`), { force: true });
  await rm(join(directory, `${transactionId}.json`), { force: true });
  await syncDirectory(directory);
}

function authorityDirectory(projectRoot: string): string {
  return join(getTransactionAuthorityRoot(), "artifact-transactions", digest(projectRoot));
}

function isAuthorityRecord(value: unknown): value is AuthorityRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && typeof record.projectRoot === "string" &&
    typeof record.transactionId === "string" && typeof record.journalSha256 === "string" &&
    /^[a-f\d]{64}$/i.test(record.journalSha256);
}

async function assertRegularDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Transaction authority directory is unsafe: ${path}`);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
