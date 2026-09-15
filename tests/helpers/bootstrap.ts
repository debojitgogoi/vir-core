/**
 * Loaded via `--require` before any src/ module, so that importing
 * src/config/env.ts picks up the test database rather than the development
 * one. Guards against ever pointing the suite at a non-test database, because
 * tests truncate tables.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  throw new Error("TEST_DATABASE_URL must be set to run the test suite");
}
if (!/test/i.test(testUrl)) {
  throw new Error(
    "TEST_DATABASE_URL must name a test database (its name must contain 'test')",
  );
}

process.env.DATABASE_URL = testUrl;
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-secret";
process.env.NODE_ENV = "test";

/**
 * Storage tests write real files: atomic rename, the traversal guard and
 * dedup-by-checksum are exactly the behaviours a fake would not have. A
 * per-run temp root keeps them out of the project directory, and out of the
 * `./storage` tree a developer's dev server is using.
 *
 * `node --test` runs each test file in its own process, so each file gets its
 * own root and can clean up after itself without racing a sibling.
 */
export const TEST_STORAGE_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "vir-test-storage-"),
);
process.env.STORAGE_ROOT = TEST_STORAGE_ROOT;
