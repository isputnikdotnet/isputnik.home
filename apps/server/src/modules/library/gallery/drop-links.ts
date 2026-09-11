// Drop links — docs/photo-inbox-proposal.md, phase 3. A guest link (share_links,
// module 'gallery-inbox') through which someone WITHOUT an account can put photos
// into a Photo Inbox: a relative with a phone full of pictures, a cousin with a
// box of prints scanned at their end. It is the first anonymous path in the app
// that writes to disk, so everything here is about keeping it bounded:
//
//   * the link is a 216-bit token, and a miss counts as abuse (resolveShareLink);
//   * it expires, like every other guest link, and can be revoked;
//   * it carries a QUOTA — at most so many files and bytes over its life — that the
//     server enforces on every batch against what has already landed, so a client
//     that ignores the number on the page changes nothing;
//   * what arrives goes into an Inbox only, which nothing resurfaces and no face
//     scan reads until a member keeps it;
//   * the uploader gets a count back, and nothing else.
//
// A one-time link closes itself when its first batch completes — for the "here,
// send me those" case — and a standing one stays open for the relative who sends
// a few every week.
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type { FastifyRequest } from "fastify";
import { db, logActivity } from "../../../db.js";
import { sha256 } from "../../../crypto.js";
import { addDays } from "../../../auth.js";
import { can, parsePolicy, type AuthUser } from "../../../core/permissions.js";
import { canUserAccessLibrary } from "../shared/library-access.js";
import { resolveShareLink } from "../shared/share-access.js";
import { validateLibrarySource } from "../shared/library-source.js";
import { normaliseRelativePath } from "../shared/storage-roots.js";
import { normalizeLibrarySettings, uploadAcceptExtensions } from "../shared/library-settings.js";
import { resolveUploadMaxBytes } from "../shared/library-crud.js";
import { receiveUploadBatch, UploadError } from "../../uploads/index.js";
import { uniqueGalleryFileName } from "./files.js";
import { scanSingleGalleryFile } from "./scanner.js";
import { normaliseTargetFolder } from "./move.js";
import type { LibraryRow as DbLibraryRow, ShareLinkRow, UserRow } from "../../../db/rows.js";

export const DROP_LINK_MODULE = "gallery-inbox";
/** Same ceiling as an ordinary gallery upload; the link's own cap may lower it. */
const MAX_DROP_FILES_PER_BATCH = 200;
/** Fallback delivery folder when the label sanitises to nothing. */
const DEFAULT_DELIVERY_FOLDER = "Dropped";

type LinkRow = Pick<ShareLinkRow,
  | "id" | "resource_id" | "label" | "expires_at" | "created_at" | "created_by" | "revoked_at"
  | "max_files" | "max_bytes" | "one_time"> & {
  creator_name: UserRow["display_name"] | null;
};

const linkRow = (id: string): LinkRow | undefined =>
  db.prepare(`
    SELECT share_links.id, share_links.resource_id, share_links.label, share_links.expires_at,
           share_links.created_at, share_links.created_by, share_links.revoked_at,
           share_links.max_files, share_links.max_bytes, share_links.one_time,
           users.display_name AS creator_name
    FROM share_links
    LEFT JOIN users ON users.id = share_links.created_by
    WHERE share_links.id = ? AND share_links.module = ?
  `).get(id, DROP_LINK_MODULE) as LinkRow | undefined;

type LibraryRow = Pick<DbLibraryRow, "id" | "name" | "source_path" | "settings_json" | "policy_json" | "created_by">;

const inboxRow = (libraryId: string): LibraryRow | undefined => {
  const row = db.prepare(
    "SELECT id, name, source_path, settings_json, policy_json, created_by FROM libraries WHERE id = ? AND type = 'gallery'"
  ).get(libraryId) as LibraryRow | undefined;
  return row && parsePolicy(row.policy_json).inbox === true ? row : undefined;
};

export interface DropUsage {
  files: number;
  bytes: number;
}

function usageOf(linkId: string): DropUsage {
  const row = db.prepare(
    "SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes FROM share_link_drops WHERE share_link_id = ?"
  ).get(linkId) as { files: number; bytes: number };
  return { files: row.files, bytes: row.bytes };
}

const remainingOf = (cap: number | null, used: number): number | null =>
  cap == null ? null : Math.max(cap - used, 0);

export interface DropLinkSummary {
  id: string;
  label: string | null;
  createdAt: string;
  expiresAt: string;
  createdBy: string;
  maxFiles: number | null;
  maxBytes: number | null;
  oneTime: boolean;
  used: DropUsage;
  /** closed = a one-time link that has had its delivery; revoked = taken back by hand. */
  status: "active" | "expired" | "closed" | "revoked";
}

function summarise(row: LinkRow): DropLinkSummary {
  const used = usageOf(row.id);
  const status: DropLinkSummary["status"] = row.revoked_at
    ? (row.one_time === 1 && used.files > 0 ? "closed" : "revoked")
    : new Date(row.expires_at).getTime() <= Date.now() ? "expired" : "active";
  return {
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    createdBy: row.creator_name ?? "(removed user)",
    maxFiles: row.max_files,
    maxBytes: row.max_bytes,
    oneTime: row.one_time === 1,
    used,
    status
  };
}

// Whether this user may hand out (and see) drop links for an Inbox: the same
// right as reviewing it. Anyone who can empty the Inbox may fill it by proxy.
function mayManage(user: AuthUser, library: LibraryRow): boolean {
  return canUserAccessLibrary(library, user.id, user.role)
    && can(user, { objectType: "library", objectId: library.id, policy: parsePolicy(library.policy_json) }, "delete");
}

export interface DropLinkInput {
  libraryId: string;
  label: string | null;
  expiresInDays: number;
  maxFiles: number | null;
  maxBytes: number | null;
  oneTime: boolean;
}

export type CreateDropLinkOutcome =
  | { ok: true; link: DropLinkSummary; token: string }
  | { ok: false; status: 403 | 404; error: string };

export function createDropLink(user: AuthUser, input: DropLinkInput): CreateDropLinkOutcome {
  const library = inboxRow(input.libraryId);
  if (!library || !canUserAccessLibrary(library, user.id, user.role)) {
    return { ok: false, status: 404, error: "Photo Inbox not found" };
  }
  if (!mayManage(user, library)) {
    return { ok: false, status: 403, error: "Only someone who can review this Inbox can hand out drop links for it." };
  }

  const id = nanoid(16);
  const token = nanoid(36);
  const expiresAt = addDays(input.expiresInDays).toISOString();
  db.prepare(`
    INSERT INTO share_links
      (id, module, resource_id, token_hash, permission, label, expires_at, created_by, max_files, max_bytes, one_time)
    VALUES (?, ?, ?, ?, 'edit', ?, ?, ?, ?, ?, ?)
  `).run(
    id, DROP_LINK_MODULE, library.id, sha256(token), input.label, expiresAt, user.id,
    input.maxFiles, input.maxBytes, input.oneTime ? 1 : 0
  );
  logActivity({
    event: "library.gallery.drop_link_created",
    actorUserId: user.id,
    targetType: "library",
    targetId: library.id,
    detail: `Created a drop link${input.label ? ` "${input.label}"` : ""} for Photo Inbox "${library.name}"`
      + ` (${input.maxFiles ?? "unlimited"} files, ${input.maxBytes == null ? "unlimited" : `${Math.round(input.maxBytes / 1048576)} MB`}, ${input.oneTime ? "one-time" : "standing"}).`,
    ipAddress: null
  });
  return { ok: true, link: summarise(linkRow(id)!), token };
}

/** The Inbox's drop links, newest first, for whoever may review it. Null when the
 *  library is not an Inbox this user may manage. */
export function listDropLinks(user: AuthUser, libraryId: string): DropLinkSummary[] | null {
  const library = inboxRow(libraryId);
  if (!library || !mayManage(user, library)) return null;
  const rows = db.prepare(`
    SELECT share_links.id, share_links.resource_id, share_links.label, share_links.expires_at,
           share_links.created_at, share_links.created_by, share_links.revoked_at,
           share_links.max_files, share_links.max_bytes, share_links.one_time,
           users.display_name AS creator_name
    FROM share_links
    LEFT JOIN users ON users.id = share_links.created_by
    WHERE share_links.module = ? AND share_links.resource_id = ?
    ORDER BY share_links.created_at DESC
  `).all(DROP_LINK_MODULE, libraryId) as LinkRow[];
  return rows.map(summarise);
}

// ── The public side ─────────────────────────────────────────────────────────

export interface DropLinkView {
  label: string | null;
  inboxName: string;
  sharedBy: string;
  expiresAt: string;
  /** Dotless extensions the Inbox accepts. */
  accept: string[];
  /** The largest single file, in bytes. */
  maxFileBytes: number;
  remainingFiles: number | null;
  remainingBytes: number | null;
  oneTime: boolean;
  received: DropUsage;
  /** False once the quota is used up. */
  open: boolean;
}

interface LiveLink {
  link: LinkRow;
  library: LibraryRow;
  view: DropLinkView;
}

function liveLink(token: string, request?: FastifyRequest): LiveLink | null {
  const resolved = resolveShareLink(token, request);
  if (!resolved || resolved.module !== DROP_LINK_MODULE) return null;
  const link = linkRow(resolved.id);
  const library = link ? inboxRow(link.resource_id) : undefined;
  if (!link || !library) return null;

  const settings = normalizeLibrarySettings("gallery", library.settings_json);
  const policy = parsePolicy(library.policy_json);
  const received = usageOf(link.id);
  const remainingFiles = remainingOf(link.max_files, received.files);
  const remainingBytes = remainingOf(link.max_bytes, received.bytes);
  const perFile = resolveUploadMaxBytes(policy.maxUploadMB);
  return {
    link,
    library,
    view: {
      label: link.label,
      inboxName: library.name,
      sharedBy: link.creator_name ?? "(removed user)",
      expiresAt: link.expires_at,
      accept: uploadAcceptExtensions(settings),
      maxFileBytes: remainingBytes == null ? perFile : Math.min(perFile, remainingBytes),
      remainingFiles,
      remainingBytes,
      oneTime: link.one_time === 1,
      received,
      open: (remainingFiles == null || remainingFiles > 0) && (remainingBytes == null || remainingBytes > 0)
    }
  };
}

/** What the drop page shows. Null for an unknown, expired or revoked token. */
export function dropLinkView(token: string, request?: FastifyRequest): DropLinkView | null {
  return liveLink(token, request)?.view ?? null;
}

export type DropOutcome =
  | { ok: true; received: number; remainingFiles: number | null; remainingBytes: number | null; closed: boolean }
  | { ok: false; status: number; error: string };

const today = (): string => new Date().toISOString().slice(0, 10);

/** Take one batch through a drop link into its Inbox. Every guard runs again here,
 *  whatever the page said. */
export async function receiveDrop(token: string, request: FastifyRequest): Promise<DropOutcome> {
  const live = liveLink(token, request);
  if (!live) return { ok: false, status: 404, error: "This link isn't valid any more." };
  const { link, library, view } = live;
  if (!view.open) return { ok: false, status: 410, error: "This link has received everything it may." };

  let root: string;
  try {
    root = validateLibrarySource(library.source_path);
  } catch (err) {
    return { ok: false, status: 400, error: err instanceof Error ? err.message : "The Inbox's folder is unavailable." };
  }

  const stagingDir = path.join(root, `.upload-drop-${nanoid(10)}`);
  const maxFiles = Math.min(MAX_DROP_FILES_PER_BATCH, view.remainingFiles ?? MAX_DROP_FILES_PER_BATCH);
  let received;
  try {
    received = await receiveUploadBatch(request, { accept: view.accept, maxBytes: view.maxFileBytes }, stagingDir, maxFiles);
  } catch (err) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    return { ok: false, status: err instanceof UploadError ? err.statusCode : 400, error: err instanceof Error ? err.message : "Upload failed" };
  }

  // The per-file cap already bounded each file; the batch as a whole must also
  // fit what the link may still receive.
  const batchBytes = received.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (view.remainingBytes != null && batchBytes > view.remainingBytes) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    return {
      ok: false,
      status: 413,
      error: `These files add up to more than this link may still receive (${Math.round(view.remainingBytes / 1048576)} MB left).`
    };
  }

  // One delivery, one folder: <label>/<date>, so the review can tell whose box
  // this is and when it came (proposal, decision 12).
  const deliveryFolder = `${normaliseTargetFolder(link.label ?? "") || DEFAULT_DELIVERY_FOLDER}/${today()}`;
  const targetDir = path.join(root, ...deliveryFolder.split("/"));
  const landed: { itemId: string; fileName: string; sizeBytes: number }[] = [];
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    for (const file of received) {
      const finalName = uniqueGalleryFileName(targetDir, file.filename);
      if (!finalName) { fs.rmSync(file.tmpPath, { force: true }); continue; }
      const finalPath = path.join(targetDir, finalName);
      fs.renameSync(file.tmpPath, finalPath);
      const relativePath = normaliseRelativePath(path.relative(root, finalPath));
      const itemId = await scanSingleGalleryFile(library.id, relativePath);
      if (itemId) landed.push({ itemId, fileName: finalName, sizeBytes: file.sizeBytes });
    }
  } catch (err) {
    return { ok: false, status: 500, error: err instanceof Error ? err.message : "Could not store the files." };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
  if (landed.length === 0) return { ok: false, status: 400, error: "No photos or videos were added from the upload." };

  // Record the delivery against the link, and close a one-time link with it.
  const closed = db.transaction(() => {
    const insert = db.prepare(
      "INSERT INTO share_link_drops (id, share_link_id, item_id, file_name, size_bytes) VALUES (?, ?, ?, ?, ?)"
    );
    for (const file of landed) insert.run(nanoid(16), link.id, file.itemId, file.fileName, file.sizeBytes);
    if (link.one_time === 1) {
      db.prepare("UPDATE share_links SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND revoked_at IS NULL")
        .run(link.id);
      return true;
    }
    return false;
  })();

  const after = usageOf(link.id);
  logActivity({
    event: "library.gallery.drop_received",
    actorUserId: null,
    targetType: "library",
    targetId: library.id,
    detail: `${landed.length} photo${landed.length === 1 ? "" : "s"} (${batchBytes} bytes) arrived in Photo Inbox "${library.name}"`
      + ` through drop link${link.label ? ` "${link.label}"` : ""}${closed ? "; the link closed" : ""}.`,
    ipAddress: request.ip
  });

  // A delivery queues the Inbox's duplicate check (proposal, decision 9); the
  // link's creator owns it when they are an admin — the cleanup page is theirs —
  // otherwise the library's creator does. Lazy, as in the scanner: the
  // duplicates module imports back into the gallery.
  const creator = db.prepare("SELECT role FROM users WHERE id = ?").get(link.created_by) as Pick<UserRow, "role"> | undefined;
  void import("./duplicates/inbox-check.js")
    .then((mod) => mod.queueInboxCheck(library.id, creator?.role === "admin" ? link.created_by : undefined))
    .catch(() => { /* started by hand from the Inbox page */ });

  return {
    ok: true,
    received: landed.length,
    remainingFiles: closed ? 0 : remainingOf(link.max_files, after.files),
    remainingBytes: closed ? 0 : remainingOf(link.max_bytes, after.bytes),
    closed
  };
}
