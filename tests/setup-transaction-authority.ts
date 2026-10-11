import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureTransactionAuthorityRoot } from "../src/main/storage/transaction-authority";

const authorityRoot = mkdtempSync(join(tmpdir(), "flowweave-test-authority-"));
process.env.FLOWWEAVE_TEST_TRANSACTION_AUTHORITY_ROOT = authorityRoot;
configureTransactionAuthorityRoot(authorityRoot);
