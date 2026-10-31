// Pairing a container with this server (docs/apps-platform-plan.md → Pairing).
//
// Where a container is, and the secret both sides sign with, can each come from
// two places, and the environment wins. The address: <APP>_URL in this
// container's environment (GAMES_URL, …), else the one saved on Settings › Apps, in
// app_settings — so a new container never needs this one's template edited, nor
// a restart. The secret:
//
//   1. <APP>_GATEWAY_SECRET in this container's environment — how games has been
//      set up since it shipped; nothing changes for an install that uses it;
//   2. a secret generated on Control panel → Settings › Apps, kept sealed in
//      app_pairings and shown once, for the owner to paste into the container's
//      template as its GATEWAY_SECRET.
//
// The gateway asks for both on every request (resolveAppSecret), so a new one
// works the moment it is made — and refuses until the container has it too.
import crypto from "node:crypto";
import { z } from "zod";
import { db } from "../../db.js";
import { config } from "../../config.js";
import { openSecret, sealSecret } from "../../core/mfa.js";
import type { AppPairingRow, AppSettingRow } from "../../db/rows.js";
import type { AppId } from "./registry.js";

export type SecretSource = "environment" | "paired" | "none";
export type AddressSource = "environment" | "saved" | "none";

/** What this install's environment says about a container. */
function environmentFor(id: AppId): { upstream: string; secret: string } {
  switch (id) {
    case "games": return { upstream: config.gamesUrl, secret: config.gamesGatewaySecret };
    case "video": return { upstream: config.videoUrl, secret: config.videoGatewaySecret };
  }
}

function pairedSecret(id: AppId): string {
  const row = db.prepare("SELECT secret_sealed FROM app_pairings WHERE app_id = ?").get(id) as Pick<AppPairingRow, "secret_sealed"> | undefined;
  return row ? openSecret(row.secret_sealed) : "";
}

// ── Addresses saved on Settings › Apps ─────────────────────────────────────────

const ADDRESSES_KEY = "apps.addresses";
const addressesSchema = z.record(z.string(), z.string());

function savedAddresses(): Record<string, string> {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(ADDRESSES_KEY) as Pick<AppSettingRow, "value"> | undefined;
  if (!row) return {};
  try {
    const parsed = addressesSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** An address as typed, tidied: trimmed, no trailing slash. "" clears it. */
export function normalizeAddress(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/** Save where a container answers ("" forgets it). The environment's address,
 *  when set, still wins. */
export function saveAppAddress(id: AppId, address: string, userId: string): void {
  const next = savedAddresses();
  const clean = normalizeAddress(address);
  if (clean) next[id] = clean;
  else delete next[id];
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_by, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_by = excluded.updated_by,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(ADDRESSES_KEY, JSON.stringify(next), userId);
}

/** The address and the secret in force for a container right now, and where each came from. */
export function resolveAppSecret(id: AppId): { upstream: string; secret: string; source: SecretSource; urlSource: AddressSource } {
  const env = environmentFor(id);
  const saved = env.upstream ? "" : (savedAddresses()[id] ?? "");
  const upstream = env.upstream || saved;
  const urlSource: AddressSource = env.upstream ? "environment" : saved ? "saved" : "none";
  if (env.secret) return { upstream, secret: env.secret, source: "environment", urlSource };
  const paired = pairedSecret(id);
  return { upstream, secret: paired, source: paired ? "paired" : "none", urlSource };
}

/** When the paired secret was made and by whom, for Settings › Apps. */
export function pairingInfo(id: AppId): { pairedAt: string; pairedBy: string | null } | null {
  const row = db.prepare(`
    SELECT p.paired_at, u.display_name AS paired_by_name
    FROM app_pairings p LEFT JOIN users u ON u.id = p.paired_by
    WHERE p.app_id = ?
  `).get(id) as { paired_at: string; paired_by_name: string | null } | undefined;
  return row ? { pairedAt: row.paired_at, pairedBy: row.paired_by_name } : null;
}

/** A new secret for the container, replacing any paired one. Returned once —
 *  only its sealed form is kept. 32 random bytes as hex: the games container
 *  refuses anything under 32 characters in production. */
export function pairApp(id: AppId, userId: string): string {
  const secret = crypto.randomBytes(32).toString("hex");
  db.prepare(`
    INSERT INTO app_pairings (app_id, secret_sealed, paired_by, paired_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(app_id) DO UPDATE SET
      secret_sealed = excluded.secret_sealed,
      paired_by = excluded.paired_by,
      paired_at = excluded.paired_at
  `).run(id, sealSecret(secret), userId);
  return secret;
}

/** Forget the paired secret: the container stops being reachable until it is
 *  paired again or the environment sets one. */
export function forgetPairing(id: AppId): boolean {
  return db.prepare("DELETE FROM app_pairings WHERE app_id = ?").run(id).changes > 0;
}
