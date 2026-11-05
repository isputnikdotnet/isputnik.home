// Phone-sync networks — where a phone may back up from (docs/photo-sync-plan.md,
// decision 2, phase 2).
//
// An admin-kept list of CIDRs, deliberately apart from core's trusted networks: those
// also skip MFA, lockout and rate limits, and adding a VPN range for phones must not
// relax sign-in for that range. The list decides WHERE FROM only — it is never
// authentication; every request also needs a live device token (devices.ts).
//
// An empty list means sync is off. Feature logic, so it lives here; only the CIDR
// helpers and the believable-address rule come from core.
import { nanoid } from "nanoid";
import { db } from "../../../../db.js";
import { ipInAnyCidr, isValidCidr } from "../../../../core/cidr.js";
import { hasForwardedHeader, isProxyTrustConfigured, listTrustedNetworks } from "../../../../core/security.js";
import type { AppSettingRow, SyncNetworkRow } from "../../../../db/rows.js";

export type SyncNetwork = Pick<SyncNetworkRow, "id" | "cidr" | "label" | "created_at">;

export function listSyncNetworks(): SyncNetwork[] {
  return db.prepare("SELECT id, cidr, label, created_at FROM sync_networks ORDER BY created_at DESC").all() as SyncNetwork[];
}

function syncCidrs(): string[] {
  return (db.prepare("SELECT cidr FROM sync_networks").all() as Pick<SyncNetworkRow, "cidr">[]).map((row) => row.cidr);
}

/** Is phone sync on at all? Off until an admin names a network. */
export function isPhoneSyncOn(): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sync_networks LIMIT 1").get());
}

export class SyncNetworkError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = "invalid") {
    super(message);
  }
}

export function addSyncNetwork(cidr: string, label: string | null, userId: string | null): string {
  const value = cidr.trim();
  if (!isValidCidr(value)) {
    throw new SyncNetworkError("Enter a valid IP address or CIDR range (e.g. 192.168.1.0/24).", 400, "bad_cidr");
  }
  if (db.prepare("SELECT 1 FROM sync_networks WHERE cidr = ?").get(value)) {
    throw new SyncNetworkError("That network is already on the list.", 409, "exists");
  }
  const id = nanoid(16);
  db.prepare("INSERT INTO sync_networks (id, cidr, label, created_by) VALUES (?, ?, ?, ?)").run(id, value, label, userId);
  return id;
}

export function removeSyncNetwork(id: string): SyncNetwork | null {
  const row = db.prepare("SELECT id, cidr, label, created_at FROM sync_networks WHERE id = ?").get(id) as SyncNetwork | undefined;
  if (!row) return null;
  db.prepare("DELETE FROM sync_networks WHERE id = ?").run(id);
  return row;
}

/** "Copy trusted networks": adds every trusted network not already listed, with its
 *  label. A one-off copy — the two lists stay separate afterwards. */
export function copyTrustedNetworks(userId: string | null): number {
  const have = new Set(syncCidrs());
  let added = 0;
  const insert = db.prepare("INSERT INTO sync_networks (id, cidr, label, created_by) VALUES (?, ?, ?, ?)");
  db.transaction(() => {
    for (const network of listTrustedNetworks()) {
      if (have.has(network.cidr)) continue;
      insert.run(nanoid(16), network.cidr, network.label, userId);
      have.add(network.cidr);
      added += 1;
    }
  })();
  return added;
}

// ── The gate ─────────────────────────────────────────────────────────────────

export type SyncGateVerdict =
  | { allowed: true }
  | { allowed: false; reason: "off" | "proxy" | "not_listed" };

/** Where-from check for one sync request, with the reason when refused. The address is
 *  believed only when it can be — the rule `isTrustedRequest` in core/security.ts
 *  follows: with a forwarding header and proxy trust unconfigured, request.ip is the
 *  proxy's own address and proves nothing, so the request is refused. Asked of this
 *  request's headers, never the process-wide "forwarded header seen" flag. */
export function syncGateVerdict(request: { ip: string | null | undefined; headers: Record<string, unknown> }): SyncGateVerdict {
  const cidrs = syncCidrs();
  if (cidrs.length === 0) return { allowed: false, reason: "off" };
  if (hasForwardedHeader(request.headers) && !isProxyTrustConfigured()) return { allowed: false, reason: "proxy" };
  if (!request.ip || !ipInAnyCidr(request.ip, cidrs)) return { allowed: false, reason: "not_listed" };
  return { allowed: true };
}

export function isSyncRequestAllowed(request: { ip: string | null | undefined; headers: Record<string, unknown> }): boolean {
  return syncGateVerdict(request).allowed;
}

// ── The address phones are told to use ───────────────────────────────────────
//
// Typed once by an admin (owner, 2026-11-05; plan open question 9): "Address phones use",
// an http(s) URL such as http://192.168.2.10:4000. Home never guesses it — not from
// APP_URL (often a public name; the endpoint is LAN/VPN only), not from the Host header,
// not from its network interfaces, which inside Docker are not the host's. Empty = the
// setup card says the admin hasn't set it yet; phones can still be added.

const ADDRESS_KEY = "photo_sync_address";

/** The admin's address, normalised to its origin, or null when it is not an http(s) URL
 *  with a host and nothing after it but "/". */
export function parseSyncAddress(input: string): string | null {
  let url: URL;
  try { url = new URL(input.trim()); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

export function getSavedSyncAddress(): string | null {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(ADDRESS_KEY) as Pick<AppSettingRow, "value"> | undefined;
  return row ? parseSyncAddress(row.value) : null;
}

/** Save (or with null, clear) the admin's address — already through parseSyncAddress. */
export function saveSyncAddress(address: string | null, userId: string | null): void {
  if (!address) {
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(ADDRESS_KEY);
    return;
  }
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_by, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(ADDRESS_KEY, address, userId);
}

/** What the setup card shows: the saved address split for PhotoSync's fields, or null. */
export function phoneSyncAddress(): { url: string; host: string; port: number; ssl: boolean } | null {
  const saved = getSavedSyncAddress();
  if (!saved) return null;
  const url = new URL(saved);
  const ssl = url.protocol === "https:";
  // An IPv6 hostname comes back bracketed ("[fd00::5]"); PhotoSync's field wants it bare.
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  return { url: saved, host, port: url.port ? Number(url.port) : ssl ? 443 : 80, ssl };
}

/** For the admin's warning (never a block): the saved address is an IP outside every
 *  listed network. A host name can't be checked, so it never warns. */
export function syncAddressOutsideNetworks(): boolean {
  const address = phoneSyncAddress();
  if (!address || !isValidCidr(address.host)) return false;
  const cidrs = syncCidrs();
  return cidrs.length > 0 && !ipInAnyCidr(address.host, cidrs);
}
