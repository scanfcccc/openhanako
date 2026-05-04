#!/usr/bin/env node
const { spawnSync } = require("node:child_process");

function canLoad() {
  try {
    const Database = require("better-sqlite3");
    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.close();
    return true;
  } catch (err) {
    const msg = String(err && (err.stack || err.message || err));
    if (!/NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|better_sqlite3\.node/i.test(msg)) {
      console.error("[native] failed to load better-sqlite3:", msg);
      process.exit(1);
    }
    return false;
  }
}

if (canLoad()) {
  process.exit(0);
}

console.warn("[native] better-sqlite3 ABI mismatch detected, rebuilding for current Node runtime...");
const rebuilt = spawnSync("npm", ["rebuild", "better-sqlite3"], { stdio: "inherit" });
if (rebuilt.status !== 0) {
  console.error("[native] npm rebuild better-sqlite3 failed.");
  process.exit(rebuilt.status || 1);
}

if (!canLoad()) {
  console.error("[native] better-sqlite3 still cannot be loaded after rebuild.");
  process.exit(1);
}

console.log("[native] better-sqlite3 is ready for this Node runtime.");
