import type { FastifyRequest } from "fastify";
import { db } from "../../../db.js";
import { sha256 } from "../../../crypto.js";
import { flagAbusiveRequest } from "../../../core/security-alerts.js";

export interface ResolvedShareLink {
  id: string;
  module: string;
  resource_id: string;
  permission: string;
  // The member who minted the link. A live album link resolves its photos against
  // THIS user's curate rights, so the serving code needs the creator on hand.
  created_by: string;
}

// Resolve a raw guest-link token to its live share row. Returns null when the
// token is unknown, revoked, or past its required expiry. Single place that
// enforces link validity — every public share route goes through it.
//
// Pass the request to have a token matching NO link at all counted as abuse: at
// ~216 bits these are unguessable, so a miss is a scan, not a mistake. A token
// that does match a link which is merely expired or revoked is deliberately not
// counted — that's the family's own stale bookmark, and blocking their IP for
// re-opening an old link would be its own outage.
export function resolveShareLink(token: string, request?: FastifyRequest): ResolvedShareLink | null {
  const hash = sha256(token);
  const row = db.prepare(`
    SELECT id, module, resource_id, permission, created_by
    FROM share_links
    WHERE token_hash = ?
      AND revoked_at IS NULL
      AND datetime(expires_at) > datetime('now')
  `).get(hash) as ResolvedShareLink | undefined;
  if (row) return row;

  if (request && !db.prepare("SELECT 1 FROM share_links WHERE token_hash = ?").get(hash)) {
    flagAbusiveRequest(request, "token");
  }
  return null;
}

// Delete all shares (guest links + user shares) for one item. Shares reference
// resources by (module, resource_id) with no FK, so module code must clean them
// up when the resource is deleted or purged.
export function deleteSharesForResource(module: string, resourceId: string) {
  db.prepare("DELETE FROM share_links WHERE module = ? AND resource_id = ?").run(module, resourceId);
  db.prepare("DELETE FROM shares WHERE module = ? AND resource_id = ?").run(module, resourceId);
}

// Delete shares for every book in a library — used before a library is hard
// deleted (its books cascade away, but their shares would otherwise orphan).
// module identifies the share namespace for this library type (e.g. "audiobook").
export function deleteSharesForLibrary(module: string, libraryId: string) {
  db.prepare(
    "DELETE FROM share_links WHERE module = ? AND resource_id IN (SELECT id FROM library_items WHERE library_id = ?)"
  ).run(module, libraryId);
  db.prepare(
    "DELETE FROM shares WHERE module = ? AND resource_id IN (SELECT id FROM library_items WHERE library_id = ?)"
  ).run(module, libraryId);
}

// True when an active (non-revoked, non-expired) user-to-user share grants this
// user access to the item. Expiry is optional for user shares (NULL = permanent).
export function userHasItemShare(module: string, resourceId: string, userId: string): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM shares
    WHERE module = ?
      AND resource_id = ?
      AND user_id = ?
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
  `).get(module, resourceId, userId);
  return Boolean(row);
}
