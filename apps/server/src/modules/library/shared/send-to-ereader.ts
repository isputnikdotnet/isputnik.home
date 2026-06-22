import fsp from "node:fs/promises";
import path from "node:path";
import { db, type User } from "../../../db.js";
import { sendMail, isMailConfigured } from "../../../core/mail.js";
import { pathIsInside } from "./storage-roots.js";
import { getLibraryForBook, canUserAccessBook, canUserDownloadBook } from "./library-access.js";
import { mediaKind } from "./library-types.js";

// EPUB and PDF are the formats Amazon's Send-to-Kindle (and Kobo's email-in) accept
// directly. Other formats (mobi/azw3/cbz/fb2) would need a conversion we don't do
// yet, so resolveSendableDocument filters to these two and the send is refused
// otherwise rather than delivering a file the device can't open.
const FORMAT_MIME: Record<string, string> = {
  epub: "application/epub+zip",
  pdf: "application/pdf"
};

interface SendableDoc {
  docId: string;
  absPath: string;
  fileName: string;
  format: string;
  mime: string;
  title: string;
}

interface DocRow {
  doc_id: string;
  relative_path: string;
  format: string;
  mime_type: string | null;
  source_path: string;
  title: string;
}

// Pick the best e-reader-ready document for a book, preferring EPUB over PDF.
// Returns null when the book has no available EPUB/PDF content file (or it resolves
// outside its library root). Path resolution mirrors streamDocumentFile.
export function resolveSendableDocument(bookId: string): SendableDoc | null {
  const row = db.prepare(`
    SELECT
      document_files.id AS doc_id,
      document_files.relative_path,
      document_files.format,
      document_files.mime_type,
      libraries.source_path,
      COALESCE(item_metadata.title, library_items.folder_path) AS title
    FROM document_files
    JOIN library_items ON library_items.id = document_files.item_id
    JOIN libraries ON libraries.id = library_items.library_id
    LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
    WHERE document_files.item_id = ?
      AND document_files.status = 'available'
      AND document_files.role = 'content'
      AND document_files.format IN ('epub', 'pdf')
      AND library_items.deleted_at IS NULL
    ORDER BY CASE document_files.format WHEN 'epub' THEN 0 ELSE 1 END
    LIMIT 1
  `).get(bookId) as DocRow | undefined;

  if (!row) return null;

  const absPath = path.join(row.source_path, ...row.relative_path.split("/"));
  if (!pathIsInside(absPath, row.source_path)) return null;

  return {
    docId: row.doc_id,
    absPath,
    fileName: row.relative_path.split("/").pop() ?? `book.${row.format}`,
    format: row.format,
    mime: row.mime_type ?? FORMAT_MIME[row.format] ?? "application/octet-stream",
    title: row.title
  };
}

export type SendResult =
  | { ok: true; title: string }
  | { ok: false; status: number; error: string };

// Email a book's EPUB/PDF to the user's e-reader address. Free of HTTP — the route
// maps the result to a status code. Guard order matches the messages so the client
// can point the user at the exact fix (configure SMTP, set an address, etc.).
export async function sendBookToEreader(bookId: string, user: User): Promise<SendResult> {
  if (!isMailConfigured()) {
    return { ok: false, status: 400, error: "Email delivery isn't set up yet. Ask an admin to configure it in Control panel → Email." };
  }

  const to = (user.ereader_email ?? "").trim();
  if (!to) {
    return { ok: false, status: 400, error: "Add your e-reader email in Profile before sending." };
  }

  const lib = getLibraryForBook(bookId);
  if (!lib || !canUserAccessBook(bookId, lib, user.id, user.role, mediaKind(lib.type))) {
    return { ok: false, status: 404, error: "Book not found." };
  }
  if (!canUserDownloadBook(bookId, lib, user.id, user.role, mediaKind(lib.type))) {
    return { ok: false, status: 403, error: "You don't have permission to download from this library." };
  }

  const doc = resolveSendableDocument(bookId);
  if (!doc) {
    return { ok: false, status: 415, error: "This book has no EPUB or PDF to send. Only EPUB and PDF can be delivered to an e-reader." };
  }

  let content: Buffer;
  try {
    content = await fsp.readFile(doc.absPath);
  } catch {
    return { ok: false, status: 404, error: "The book file is missing on disk." };
  }

  try {
    await sendMail({
      to,
      subject: doc.title,
      text: `"${doc.title}" sent from your iSputnik library.`,
      attachments: [{ filename: doc.fileName, content, contentType: doc.mime }]
    });
  } catch (err) {
    return { ok: false, status: 502, error: err instanceof Error ? err.message : "Unable to send the email." };
  }

  return { ok: true, title: doc.title };
}
