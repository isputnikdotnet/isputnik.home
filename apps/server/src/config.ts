import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd().includes(path.join("apps", "server"))
  ? path.resolve(process.cwd(), "..", "..")
  : process.cwd();
const packageInfo = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")) as {
  version: string;
  description: string;
};

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
  // HSTS only means something once TLS terminates in front of the app, and a
  // max-age handed to a browser on a plain-http LAN deployment would strand it.
  // APP_URL is the operator's own statement of how the app is reached, so it
  // gates the header; HSTS=false opts out when the proxy sends its own.
  hsts: (process.env.APP_URL ?? "").startsWith("https://") && process.env.HSTS !== "false",
  sessionDays: Number(process.env.SESSION_DAYS ?? 14),
  inviteDays: Number(process.env.INVITE_DAYS ?? 7),
  version: packageInfo.version,
  description: packageInfo.description
};
