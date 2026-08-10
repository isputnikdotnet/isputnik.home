import path from "node:path";
import { db } from "../../../db.js";
import { sendMail } from "../../../core/mail.js";
import { renderEmail, type EmailBlock, type EmailContent } from "../../../core/email-template.js";
import { shareNotificationsEnabled } from "../../../core/notifications.js";
import type { MediaModule } from "./library-types.js";

// Tells a recipient, by email, that something was just shared with them — the one
// piece of outgoing mail aimed at ordinary members rather than admins. It follows
// the security-alert pattern in core/security-alerts.ts: every entry point is
// fire-and-forget (`notifyShareGranted(…)` returns void and swallows delivery
// errors), so a broken relay or an unconfigured SMTP host can never fail the share
// that triggered it.
//
// Two gates, both deliberate:
//   • shareNotificationsEnabled() — the admin's Control panel → Settings →
//     Notifications toggle, on top of "is SMTP even configured". Off by default:
//     nobody's household starts sending mail because of an upgrade.
//   • newlySharedResources() — a grant is an upsert (re-sharing refreshes the
//     expiry instead of erroring), so without this, opening the share dialog and
//     pressing Share again would mail the recipient a second time about access
//     they already have.
//
// Guest links have no recipient account, so only the three user-to-user grants in
// shares.ts notify.

const FOOTER = "— Automated notification from your iSputnik server.";

// What the recipient is being told they now have. Mirrors the three grant routes:
// one item of any media type, a selection of gallery items, or a live album.
export type SharedThing =
  | { kind: "item"; module: MediaModule; itemId: string }
  | { kind: "photos"; count: number }
  | { kind: "album"; name: string };

// The resources the recipient does NOT already have live access to. Call it
// BEFORE the upsert — afterwards every row looks current and nothing is new.
// An expired or revoked grant counts as new again: access genuinely returns.
export function newlySharedResources(module: string, resourceIds: string[], userId: string): string[] {
  const ids = [...new Set(resourceIds)];
  if (ids.length === 0) return [];
  const held = new Set(
    (db.prepare(`
      SELECT resource_id FROM shares
      WHERE module = ? AND user_id = ? AND revoked_at IS NULL
        AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
        AND resource_id IN (${ids.map(() => "?").join(", ")})
    `).all(module, userId, ...ids) as { resource_id: string }[]).map((row) => row.resource_id)
  );
  return ids.filter((id) => !held.has(id));
}

interface RecipientRow {
  email: string;
  display_name: string;
}

function loadRecipient(userId: string): RecipientRow | undefined {
  return db.prepare(
    "SELECT email, display_name FROM users WHERE id = ? AND deleted_at IS NULL AND is_active = 1"
  ).get(userId) as RecipientRow | undefined;
}

function displayName(userId: string): string {
  const row = db.prepare("SELECT display_name FROM users WHERE id = ?").get(userId) as
    | { display_name: string }
    | undefined;
  return row?.display_name || "Someone";
}

interface ItemFactsRow {
  title: string | null;
  folder_path: string;
  kind: string | null;
}

// The item's name and what to call it. Falls back to the folder name the same way
// the public share routes do, so an item the scanner never titled still reads as
// something rather than a blank pair of quotes.
function itemFacts(itemId: string): { title: string; noun: string } | null {
  const row = db.prepare(`
    SELECT item_metadata.title, library_items.folder_path, gallery_details.kind
    FROM library_items
    LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
    LEFT JOIN gallery_details ON gallery_details.item_id = library_items.id
    WHERE library_items.id = ? AND library_items.deleted_at IS NULL
  `).get(itemId) as ItemFactsRow | undefined;
  if (!row) return null;
  return {
    title: row.title?.trim() || path.basename(row.folder_path) || "an item",
    noun: row.kind === "video" ? "a video" : row.kind === "photo" ? "a photo" : ""
  };
}

const BOOK_NOUN: Record<string, string> = { audiobook: "an audiobook", ebook: "a book" };

// Subject lines carry the title because that's what makes the mail scannable in a
// list; cap it so a 300-character audiobook title doesn't run the header off.
function clip(value: string, max = 90): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

interface Message {
  subject: string;
  lead: string;
  /** The thing itself, called out; empty when there is no single name for it. */
  named: string | null;
  extra: string | null;
}

function compose(thing: SharedThing, sharer: string): Message | null {
  if (thing.kind === "album") {
    return {
      subject: `${sharer} shared the album "${clip(thing.name)}" with you`,
      lead: `${sharer} shared a photo album with you on iSputnik.`,
      named: thing.name,
      extra: "It stays up to date — photos added to the album later show up for you too."
    };
  }
  if (thing.kind === "photos") {
    const many = thing.count !== 1;
    const what = many ? `${thing.count} photos` : "a photo";
    return {
      subject: `${sharer} shared ${what} with you`,
      lead: `${sharer} shared ${what} with you on iSputnik.`,
      named: null,
      extra: null
    };
  }
  const facts = itemFacts(thing.itemId);
  if (!facts) return null;
  const noun = facts.noun || BOOK_NOUN[thing.module] || "an item";
  return {
    subject: `${sharer} shared "${clip(facts.title)}" with you`,
    lead: `${sharer} shared ${noun} with you on iSputnik.`,
    named: facts.title,
    extra: null
  };
}

async function deliver(to: string, subject: string, content: EmailContent): Promise<void> {
  try {
    const { html, text } = renderEmail(content);
    await sendMail({ to, subject, text, html });
  } catch {
    // Best-effort: a share must succeed whether or not the mail goes out.
  }
}

export function notifyShareGranted(opts: {
  recipientId: string;
  sharedById: string;
  // Origin of the page the sharer is on, so the link lands on the same host they
  // reached the app through (see requestOrigin) rather than a configured default.
  origin: string;
  expiresAt: string | null;
  thing: SharedThing;
}): void {
  if (!shareNotificationsEnabled()) return;
  const recipient = loadRecipient(opts.recipientId);
  if (!recipient?.email) return;

  const message = compose(opts.thing, displayName(opts.sharedById));
  if (!message) return;

  const blocks: EmailBlock[] = [
    { kind: "text", text: `Hello ${recipient.display_name},` },
    { kind: "text", text: message.lead }
  ];
  if (message.named) blocks.push({ kind: "subject", text: message.named });
  if (message.extra) blocks.push({ kind: "text", text: message.extra });
  blocks.push({ kind: "button", label: "Open Shared with me", url: `${opts.origin}/shared` });
  if (opts.expiresAt) {
    blocks.push({ kind: "note", text: `Your access expires on ${opts.expiresAt.slice(0, 10)}.` });
  }
  blocks.push({ kind: "note", text: "Signing in to your own account is still what opens it — this message carries no files." });

  void deliver(recipient.email, message.subject, {
    title: message.subject,
    preheader: message.lead,
    blocks,
    footnote: FOOTER
  });
}
