import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock only the transport so nothing leaves the test; isMailConfigured/getMailSettings
// stay real and read the in-memory app_settings, which is what the guards check.
vi.mock("../src/core/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/mail.js")>();
  return { ...actual, sendMail: vi.fn(async () => {}) };
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, type User } from "../src/db.js";
import { sendMail } from "../src/core/mail.js";
import { sendBookToEreader, resolveSendableDocument } from "../src/modules/library/shared/send-to-ereader.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

const MIME: Record<string, string> = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
  mobi: "application/x-mobipocket-ebook"
};

function configureMail(): void {
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('mail_settings', ?)").run(
    JSON.stringify({ host: "smtp.test", port: 587, secure: false, username: "", password: "", fromAddress: "lib@test.local", fromName: "Lib" })
  );
}

function setEreader(userId: string, email: string | null): void {
  db.prepare("UPDATE users SET ereader_email = ? WHERE id = ?").run(email, userId);
}

function getUser(userId: string): User {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as User;
}

function seedItem(libraryId: string, itemId: string): void {
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, ?, 'ebook', ?, 'ready')").run(itemId, libraryId, `path/${itemId}`);
  db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES (?, 'scan', 'Test Book')").run(itemId);
}

function addDoc(itemId: string, format: string, relPath = `${itemId}.${format}`): string {
  db.prepare("INSERT INTO document_files (id, item_id, role, relative_path, format, mime_type, size, status) VALUES (?, ?, 'content', ?, ?, ?, 10, 'available')")
    .run(`${itemId}-${format}`, itemId, relPath, format, MIME[format] ?? "application/octet-stream");
  return relPath;
}

beforeEach(() => {
  resetDb();
  db.prepare("DELETE FROM app_settings WHERE key = 'mail_settings'").run();
  vi.clearAllMocks();
  makeUser("u1"); // member by default
});

describe("resolveSendableDocument", () => {
  it("prefers EPUB over PDF", () => {
    makeLibrary("L1", { createdBy: "u1", type: "ebook" });
    // Use a real, OS-normalised root so the inside-root path check matches separators.
    db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'L1'").run(os.tmpdir());
    seedItem("L1", "b1");
    addDoc("b1", "pdf");
    addDoc("b1", "epub");
    expect(resolveSendableDocument("b1")?.format).toBe("epub");
  });

  it("returns null when the only content file is a non-sendable format", () => {
    makeLibrary("L1", { createdBy: "u1", type: "ebook" });
    seedItem("L1", "b1");
    addDoc("b1", "mobi");
    expect(resolveSendableDocument("b1")).toBeNull();
  });
});

describe("sendBookToEreader guards", () => {
  function seedSendable(role: "viewer" | "member" | "manager" = "member"): void {
    makeLibrary("L1", { createdBy: "u1", type: "ebook" });
    grant("user", "u1", "L1", role);
    seedItem("L1", "b1");
    addDoc("b1", "epub");
  }

  it("rejects with 400 when email is not configured", async () => {
    seedSendable();
    setEreader("u1", "u1@kindle.test");
    const result = await sendBookToEreader("b1", getUser("u1"));
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("rejects with 400 when the user has no e-reader email", async () => {
    configureMail();
    seedSendable();
    setEreader("u1", null);
    const result = await sendBookToEreader("b1", getUser("u1"));
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("rejects with 403 when the user can view but not download", async () => {
    configureMail();
    seedSendable("viewer"); // viewer => access yes, download no
    setEreader("u1", "u1@kindle.test");
    const result = await sendBookToEreader("b1", getUser("u1"));
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("rejects with 415 when the book has no EPUB or PDF", async () => {
    configureMail();
    makeLibrary("L1", { createdBy: "u1", type: "ebook" });
    grant("user", "u1", "L1", "member");
    seedItem("L1", "b1");
    addDoc("b1", "mobi");
    setEreader("u1", "u1@kindle.test");
    const result = await sendBookToEreader("b1", getUser("u1"));
    expect(result).toMatchObject({ ok: false, status: 415 });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("sends the EPUB as an attachment on the happy path", async () => {
    configureMail();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isp-send-"));
    makeLibrary("L1", { createdBy: "u1", type: "ebook" });
    db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'L1'").run(dir);
    grant("user", "u1", "L1", "member");
    seedItem("L1", "b1");
    addDoc("b1", "epub", "book.epub");
    fs.writeFileSync(path.join(dir, "book.epub"), "FAKE-EPUB-BYTES");
    setEreader("u1", "u1@kindle.test");

    const result = await sendBookToEreader("b1", getUser("u1"));
    expect(result.ok).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const arg = (sendMail as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      to: string;
      attachments: { filename: string; contentType?: string }[];
    };
    expect(arg.to).toBe("u1@kindle.test");
    expect(arg.attachments[0].filename).toBe("book.epub");
    expect(arg.attachments[0].contentType).toBe("application/epub+zip");

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
