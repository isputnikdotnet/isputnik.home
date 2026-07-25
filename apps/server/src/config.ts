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

// Secure cookies are never sent over plain http, so getting this wrong doesn't
// degrade the deployment — it locks everyone out of it: the session and CSRF
// cookies are dropped by the browser and sign-in fails outright.
//
//   true / false  the operator decides, and is obeyed
//   unset         production defaults to secure, as it always has
//   anything else follows APP_URL, the same signal HSTS and the redirect use
//
// That last line is the important one. The Unraid template shipped "auto",
// described as automatic HTTPS detection, and no such branch existed: being
// neither "true" nor "false" it fell into the production default and turned
// secure cookies ON for exactly the plain-http home installs that cannot use
// them. Unrecognised values now resolve the way "auto" always claimed to,
// which repairs those installs on update instead of only new ones.
function resolveCookieSecure(): boolean {
  const value = (process.env.COOKIE_SECURE ?? "").trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "") return process.env.NODE_ENV === "production";
  return appUrlIsHttps;
}

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
  cookieSecure: resolveCookieSecure(),
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
