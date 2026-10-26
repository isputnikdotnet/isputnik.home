// Pairing a container with this server (docs/apps-platform-plan.md → Pairing).
//
// Where a container is stays the install's environment (GAMES_URL, …): the
// address is a deployment fact. The secret both sides sign with can come from
// two places, and the environment wins:
//
//   1. <APP>_GATEWAY_SECRET in this container's environment — how games has been
//      set up since it shipped; nothing changes for an install that uses it;
//   2. a secret generated on Control panel → Apps → Setup, kept sealed in
//      app_pairings and shown once, for the owner to paste into the container's
//      template as its GATEWAY_SECRET.
//
// The gateway asks for the secret on every request (resolveAppSecret), so a new
// one works the moment it is made — and refuses until the container has it too.
import crypto from "node:crypto";
import { db } from "../../db.js";
import { config } from "../../config.js";
import { openSecret, sealSecret } from "../../core/mfa.js";
import type { AppPairingRow } from "../../db/rows.js";
import type { AppId } from "./registry.js";

export type SecretSource = "environment" | "paired" | "none";

/** What this install's environment says about a container. */
function environmentFor(id: AppId): { upstream: string; secret: string } {
  switch (id) {
    case "games": return { upstream: config.gamesUrl, secret: config.gamesGatewaySecret };
  }
}

function pairedSecret(id: AppId): string {
  const row = db.prepare("SELECT secret_sealed FROM app_pairings WHERE app_id = ?").get(id) as Pick<AppPairingRow, "secret_sealed"> | undefined;
  return row ? openSecret(row.secret_sealed) : "";
}

/** The address and the secret in force for a container right now, and where the secret came from. */
export function resolveAppSecret(id: AppId): { upstream: string; secret: string; source: SecretSource } {
  const env = environmentFor(id);
  if (env.secret) return { upstream: env.upstream, secret: env.secret, source: "environment" };
  const paired = pairedSecret(id);
  return { upstream: env.upstream, secret: paired, source: paired ? "paired" : "none" };
}

/** When the paired secret was made and by whom, for Apps → Setup. */
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
