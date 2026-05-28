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
  dbPath: process.env.DB_PATH ?? path.join(rootDir, "data", "db", "isputnik.sqlite"),
  thumbnailPath: process.env.THUMBNAIL_PATH ?? "",
  metadataPath: process.env.METADATA_PATH ?? "",
  cookieSecure: process.env.NODE_ENV === "production",
  sessionDays: Number(process.env.SESSION_DAYS ?? 14),
  inviteDays: Number(process.env.INVITE_DAYS ?? 7),
  version: packageInfo.version,
  description: packageInfo.description
};
