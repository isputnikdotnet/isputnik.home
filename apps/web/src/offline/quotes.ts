import { api } from "../api";
import { openOfflineDb, type QueuedQuote } from "./downloads";
import type { Quote } from "../features/audiobooks/types";

// Offline capture for reader quotes/highlights. Mirrors offline/progress.ts: save
// the write so it survives no-connection reading of a downloaded book, push it to
// the server, and retry on reconnect via flushQuoteQueue(). Unlike progress (one
// row per book, latest wins) quotes are append-only, so a successful POST simply
// deletes the local row rather than marking it synced.

interface QuoteInput {
  itemId: string;
  documentId: string;
  cfi: string | null;
  text: string;
  color: string | null;
  percentComplete: number | null;
}

// Attribution shown on a not-yet-synced quote. The server fills these from the
// live item on POST, so they only matter while the row is local.
interface QuoteDisplay {
  sourceTitle: string | null;
  sourceAuthors: string[];
}

function postQuote(input: QuoteInput) {
  return api<{ quote: Quote }>("/api/library/quotes", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

function newLocalId(): string {
  try {
    return `local-${crypto.randomUUID()}`;
  } catch {
    return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

// A pending offline quote, identified by its local id so the reader can render and
// later delete/recolour it before it has a server id.
export function isLocalQuoteId(id: string): boolean {
  return id.startsWith("local-");
}

function syntheticQuote(row: QueuedQuote, display: QuoteDisplay): Quote {
  return {
    id: row.localId,
    itemId: row.itemId,
    documentId: row.documentId,
    cfi: row.cfi,
    text: row.text,
    note: null,
    color: row.color,
    percentComplete: row.percentComplete,
    sourceTitle: display.sourceTitle,
    sourceAuthors: display.sourceAuthors,
    libraryType: null,
    coverUrl: null,
    createdAt: row.createdAt,
    updatedAt: row.createdAt
  };
}

/**
 * Save a quote: POST it when online, otherwise persist it locally and return a
 * synthetic Quote (keyed by a local id) so the highlight shows immediately. The
 * on-page mark is keyed by CFI, so it renders the same before and after sync.
 */
export async function saveQuote(input: QuoteInput, display: QuoteDisplay): Promise<Quote> {
  try {
    const { quote } = await postQuote(input);
    return quote;
  } catch {
    const row: QueuedQuote = {
      localId: newLocalId(),
      itemId: input.itemId,
      documentId: input.documentId,
      cfi: input.cfi,
      text: input.text,
      color: input.color,
      percentComplete: input.percentComplete,
      createdAt: new Date().toISOString(),
      synced: false
    };
    const handle = openOfflineDb();
    if (handle) {
      try { await (await handle).put("quotesQueue", row); } catch { /* private mode / quota */ }
    }
    return syntheticQuote(row, display);
  }
}

/** Pending (unsynced) quotes for a document, as display Quotes. */
export async function getLocalQuotes(documentId: string, display: QuoteDisplay): Promise<Quote[]> {
  const handle = openOfflineDb();
  if (!handle) return [];
  try {
    const rows = await (await handle).getAllFromIndex("quotesQueue", "documentId", documentId);
    return rows.map((row) => syntheticQuote(row, display));
  } catch {
    return [];
  }
}

export async function deleteLocalQuote(localId: string): Promise<void> {
  const handle = openOfflineDb();
  if (!handle) return;
  try { await (await handle).delete("quotesQueue", localId); } catch { /* ignore */ }
}

export async function updateLocalQuoteColor(localId: string, color: string): Promise<void> {
  const handle = openOfflineDb();
  if (!handle) return;
  try {
    const db = await handle;
    const row = await db.get("quotesQueue", localId);
    if (row) await db.put("quotesQueue", { ...row, color });
  } catch { /* ignore */ }
}

/** Push every pending quote to the server, deleting each on success. Returns count flushed. */
export async function flushQuoteQueue(): Promise<number> {
  const handle = openOfflineDb();
  if (!handle) return 0;
  let flushed = 0;
  try {
    const db = await handle;
    const rows = await db.getAll("quotesQueue");
    for (const row of rows) {
      try {
        await postQuote({
          itemId: row.itemId,
          documentId: row.documentId,
          cfi: row.cfi,
          text: row.text,
          color: row.color,
          percentComplete: row.percentComplete
        });
        await db.delete("quotesQueue", row.localId);
        flushed += 1;
      } catch {
        // Still offline / failing — keep it for the next attempt.
      }
    }
  } catch { /* ignore */ }
  return flushed;
}
