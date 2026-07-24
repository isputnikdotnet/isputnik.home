// tsc only emits .js; copy non-TS runtime assets into dist so production code can
// read them: the SQL schema (db/migrate.js) and src/assets/** (e.g. the bundled
// title-card font for slideshow renders). Run after tsc in `build`.
import fs from "node:fs";
import path from "node:path";

const schemaSrc = path.join(process.cwd(), "src", "db", "schema.sql");
const schemaDestDir = path.join(process.cwd(), "dist", "db");
fs.mkdirSync(schemaDestDir, { recursive: true });
fs.copyFileSync(schemaSrc, path.join(schemaDestDir, "schema.sql"));
console.log("copied schema.sql -> dist/db/schema.sql");

const assetsSrc = path.join(process.cwd(), "src", "assets");
if (fs.existsSync(assetsSrc)) {
  const assetsDest = path.join(process.cwd(), "dist", "assets");
  fs.cpSync(assetsSrc, assetsDest, { recursive: true });
  console.log("copied src/assets -> dist/assets");
}
