// tsc only emits .js; copy non-TS runtime assets (the SQL schema) into dist so
// db/migrate.js can read schema.sql in production. Run after tsc in `build`.
import fs from "node:fs";
import path from "node:path";

const src = path.join(process.cwd(), "src", "db", "schema.sql");
const destDir = path.join(process.cwd(), "dist", "db");
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, path.join(destDir, "schema.sql"));
console.log("copied schema.sql -> dist/db/schema.sql");
