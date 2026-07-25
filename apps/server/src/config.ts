import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd().includes(path.join("apps", "server"))
  ? path.resolve(process.cwd(), "..", "..")
  : process.cwd();
const packageInfo = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")) as {
  version: string;
  description: string;
};

// APP_URL is the operator's own statement of how the app is reached, and it's the
// only thing the process knows about its own scheme: TLS terminates at a proxy, so
// every request arrives over plain http regardless of how the visitor got there.
// Both HTTPS behaviours below hang off it, so neither can fire on a plain-http LAN
// deployment — the default, which has to keep working.
const appUrlIsHttps = (process.env.APP_URL ?? "").startsWith("https://");

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 4000),
  appUrl: process.env.APP_URL ?? "http://127.0.0.1:5173",
  staticPath: process.env.STATIC_PATH ?? "",
  dbPath: process.env.DB_PATH ?? path.join(rootDir, "data", "db", "isputnik.sqlite"),
  thumbnailPath: process.env.THUMBNAIL_PATH ?? "",
  metadataPath: process.env.METADATA_PATH ?? "",
  backupPath: process.env.BACKUP_PATH ?? path.join(rootDir, "data", "backups"),
  backupRetention: Number(process.env.BACKUP_RETENTION ?? 10),
  cookieSecure: process.env.COOKIE_SECURE === "true" || (process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "false"),
  // HSTS=false opts out where the reverse proxy sends its own header.
  hsts: appUrlIsHttps && process.env.HSTS !== "false",
  // Redirect http → https. Opts out separately from HSTS: a proxy that already
  // redirects is a different situation from one that already sends HSTS, and an
  // operator can have either without the other.
  httpsRedirect: appUrlIsHttps && process.env.HTTPS_REDIRECT !== "false",
  sessionDays: Number(process.env.SESSION_DAYS ?? 14),
  inviteDays: Number(process.env.INVITE_DAYS ?? 7),
  version: packageInfo.version,
  description: packageInfo.description
};
