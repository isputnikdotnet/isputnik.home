import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { sha256 } from "../src/crypto.js";
import { resolveShareLink, userHasItemShare } from "../src/modules/library/shared/share-access.js";
import { resetDb, makeUser, makeShare, futureIso, pastIso } from "./helpers/seed.js";

function makeShareLink(opts: { token: string; expiresAt: string; revoked?: boolean }): void {
  db.prepare(
    "INSERT INTO share_links (id, module, resource_id, token_hash, expires_at, created_by, revoked_at) VALUES (?, 'audiobook', 'book-1', ?, ?, ?, ?)"
  ).run(`link-${opts.token}`, sha256(opts.token), opts.expiresAt, "owner", opts.revoked ? new Date().toISOString() : null);
}

beforeEach(() => {
  resetDb();
  makeUser("owner");
  makeUser("friend");
});

describe("resolveShareLink (guest-link token validity)", () => {
  it("resolves a live, unexpired token to its share row", () => {
    makeShareLink({ token: "secret", expiresAt: futureIso() });
    const resolved = resolveShareLink("secret");
    expect(resolved?.resource_id).toBe("book-1");
    expect(resolved?.module).toBe("audiobook");
  });

  it("returns null for an unknown token", () => {
    makeShareLink({ token: "secret", expiresAt: futureIso() });
    expect(resolveShareLink("wrong-token")).toBeNull();
  });

  it("returns null for a revoked token", () => {
    makeShareLink({ token: "secret", expiresAt: futureIso(), revoked: true });
    expect(resolveShareLink("secret")).toBeNull();
  });

  it("returns null for an expired token", () => {
    makeShareLink({ token: "secret", expiresAt: pastIso() });
    expect(resolveShareLink("secret")).toBeNull();
  });
});

describe("userHasItemShare (user-to-user share validity)", () => {
  it("is true for an active share", () => {
    makeShare({ module: "audiobook", resourceId: "book-1", userId: "friend", createdBy: "owner", expiresAt: futureIso() });
    expect(userHasItemShare("audiobook", "book-1", "friend")).toBe(true);
  });

  it("treats a null expiry as a permanent share", () => {
    makeShare({ module: "audiobook", resourceId: "book-1", userId: "friend", createdBy: "owner", expiresAt: null });
    expect(userHasItemShare("audiobook", "book-1", "friend")).toBe(true);
  });

  it("is false once revoked", () => {
    makeShare({ module: "audiobook", resourceId: "book-1", userId: "friend", createdBy: "owner", revoked: true });
    expect(userHasItemShare("audiobook", "book-1", "friend")).toBe(false);
  });

  it("is false once expired", () => {
    makeShare({ module: "audiobook", resourceId: "book-1", userId: "friend", createdBy: "owner", expiresAt: pastIso() });
    expect(userHasItemShare("audiobook", "book-1", "friend")).toBe(false);
  });

  it("does not leak across users", () => {
    makeShare({ module: "audiobook", resourceId: "book-1", userId: "friend", createdBy: "owner", expiresAt: futureIso() });
    expect(userHasItemShare("audiobook", "book-1", "owner")).toBe(false);
  });
});
