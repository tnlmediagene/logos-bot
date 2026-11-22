import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildSyncSql } from "./dump-catalog";

const D1_DATABASE = "logos-bot-catalog";

interface Options {
  dbPath: string;
  target: "local" | "remote" | "dump-only";
  outFile: string;
}

function parseArgs(argv: string[]): Options {
  const dbPath = process.env.DATABASE_PATH || "./data/catalog.db";
  let target: Options["target"] = "dump-only";
  if (argv.includes("--remote")) target = "remote";
  else if (argv.includes("--local")) target = "local";
  const outFile =
    process.env.SYNC_OUT_FILE ||
    join(process.env.KIROCREW_SCRATCH || process.env.TMPDIR || ".", "logos-d1-sync.sql");
  return { dbPath, target, outFile };
}

function main(): void {
  const { dbPath, target, outFile } = parseArgs(process.argv.slice(2));

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let sql: string;
  try {
    sql = buildSyncSql(db);
  } finally {
    db.close();
  }

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, sql, "utf-8");
  const stmtCount = sql.split("\n").filter((l) => l.startsWith("INSERT INTO")).length;
  console.log(`📝 Wrote sync SQL → ${outFile} (${stmtCount} INSERT statement(s))`);

  if (target === "dump-only") {
    console.log("ℹ️  dump-only: no D1 write. Pass --local or --remote to apply.");
    console.log(`   Manual apply: npx wrangler d1 execute ${D1_DATABASE} --local --file ${outFile}`);
    return;
  }

  const flag = target === "remote" ? "--remote" : "--local";
  console.log(`🚀 Applying to D1 (${target})…`);
  const result = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", D1_DATABASE, flag, "--yes", "--file", outFile],
    { stdio: "inherit" }
  );
  if (result.status !== 0) {
    console.error(`❌ wrangler d1 execute failed (exit ${result.status ?? "signal"})`);
    process.exit(result.status || 1);
  }
  console.log(`✅ Catalog synced to ${target} D1 (${D1_DATABASE}).`);
}

main();
