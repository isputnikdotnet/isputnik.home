import { nanoid } from "nanoid";
import { db } from "../db.js";

const SERVER_ID_KEY = "server_id";

/** This install's random id, made the first time it is asked for. It tells this
 *  server apart from every other iSputnik: the origin of the records in a family
 *  tree package, the Stremio add-on's id and item ids (docs/stremio-plan.md).
 *  It lives in the database, so it survives upgrades and a restore onto new
 *  hardware — and a copied database carries it along. */
export function getServerId(): string {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(SERVER_ID_KEY) as { value: string } | undefined;
  if (row?.value) return row.value;
  const id = nanoid(16);
  db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)").run(SERVER_ID_KEY, id);
  return (db.prepare("SELECT value FROM app_settings WHERE key = ?").get(SERVER_ID_KEY) as { value: string }).value;
}
