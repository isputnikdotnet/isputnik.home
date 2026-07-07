import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { bulkSaveItems } from "../src/modules/library/audiobook/saves.js";
import { appendCollectionItems } from "../src/modules/collections/routes.js";
import { kindForExtension } from "../src/modules/library/gallery/media.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

// Same synthetic-asset trick as gallery.test.ts: metaEnabled=false never touches
// the (non-existent) file; taken_at falls back to the mtime we set.
function asset(relativePath: string) {
  const extension = `.${relativePath.split(".").pop()}`;
  return {
    absolutePath: `/src/GAL/${relativePath}`,
    relativePath,
    fileName: relativePath.split("/").pop()!,
    extension,
    kind: kindForExtension(extension)!,
    size: 1000,
    modifiedAtMs: Date.parse("2024-06-01T00:00:00Z")
  };
}

const user = { id: "u1", role: "member" };
let a = "";
let b = "";
let secret = "";

beforeEach(async () => {
  resetDb();
  makeUser("u1");
  makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
  // A private gallery u1 has NO grant on — its asset must count as forbidden.
  makeUser("owner");
  makeLibrary("PRIV", { createdBy: "owner", type: "gallery" });
  grant("user", "owner", "PRIV", "manager");
  a = (await ingestGalleryAsset("GAL", asset("a.jpg"), false))!;
  b = (await ingestGalleryAsset("GAL", asset("b.jpg"), false))!;
  secret = (await ingestGalleryAsset("PRIV", asset("secret.jpg"), false))!;
});

describe("bulkSaveItems", () => {
  it("saves accessible items and counts inaccessible/unknown ones as forbidden", () => {
    const result = bulkSaveItems(user, [a, b, secret, "no-such-item"]);
    expect(result).toEqual({ saved: 2, forbidden: 2 });
    const rows = db.prepare("SELECT item_id FROM item_saves WHERE user_id = 'u1' ORDER BY item_id").all() as { item_id: string }[];
    expect(rows.map((r) => r.item_id).sort()).toEqual([a, b].sort());
  });

  it("is idempotent and never clobbers an existing note", () => {
    db.prepare("INSERT INTO item_saves (id, user_id, item_id, note) VALUES ('s1', 'u1', ?, 'keep me')").run(a);
    const result = bulkSaveItems(user, [a, a, b]);
    expect(result.saved).toBe(2); // deduped input: a + b
    expect((db.prepare("SELECT COUNT(*) AS n FROM item_saves WHERE user_id = 'u1'").get() as { n: number }).n).toBe(2);
    expect((db.prepare("SELECT note FROM item_saves WHERE user_id = 'u1' AND item_id = ?").get(a) as { note: string | null }).note).toBe("keep me");
  });
});

describe("appendCollectionItems", () => {
  beforeEach(() => {
    db.prepare("INSERT INTO collections (id, user_id, name) VALUES ('c1', 'u1', 'Trip')").run();
  });

  it("appends accessible entities once, in sequential positions", () => {
    expect(appendCollectionItems("c1", user, "gallery", [a, b])).toEqual({ added: 2, skipped: 0 });
    // Re-adding is a no-op, not a duplicate or an error.
    expect(appendCollectionItems("c1", user, "gallery", [a, b])).toEqual({ added: 0, skipped: 2 });
    const rows = db.prepare(
      "SELECT entity_id, position FROM collection_items WHERE collection_id = 'c1' ORDER BY position"
    ).all() as { entity_id: string; position: number }[];
    expect(rows.map((r) => r.entity_id)).toEqual([a, b]);
    expect(rows[1].position).toBeGreaterThan(rows[0].position);
  });

  it("skips entities the caller cannot access", () => {
    expect(appendCollectionItems("c1", user, "gallery", [secret, a])).toEqual({ added: 1, skipped: 1 });
    const rows = db.prepare("SELECT entity_id FROM collection_items WHERE collection_id = 'c1'").all() as { entity_id: string }[];
    expect(rows.map((r) => r.entity_id)).toEqual([a]);
  });
});
