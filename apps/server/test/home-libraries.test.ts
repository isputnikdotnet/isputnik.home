// What the top layout's Home asks of the server: how much is in each library, for
// this person only, and when each book in progress was last touched.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, THEME_PREFERENCES } from "../src/db.js";
import { identityHeaders } from "../src/modules/apps/gateway.js";
import { homePlugin } from "../src/modules/home/index.js";
import { inProgress } from "../src/modules/library/feed.js";
import { bootApp, type BootedApp } from "./helpers/boot.js";
import { grant, makeLibrary, makeUser, resetDb } from "./helpers/seed.js";

let booted: BootedApp;

function makeItem(id: string, libraryId: string, type: "audiobook" | "ebook" | "gallery"): void {
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path) VALUES (?, ?, ?, ?)").run(id, libraryId, type, `/src/${libraryId}/${id}`);
  if (type === "gallery") {
    db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path, taken_at) VALUES (?, 'photo', ?, '2024-01-01T00:00:00.000Z')").run(id, `${id}.jpg`);
  }
}

beforeEach(async () => {
  resetDb();
  makeUser("dad", "member");
  makeUser("mum", "member");
  makeLibrary("audio", { createdBy: "dad", type: "audiobook", ownerId: "dad", ownerType: "user" });
  makeLibrary("books", { createdBy: "dad", type: "ebook", ownerId: "dad", ownerType: "user" });
  makeLibrary("pics", { createdBy: "dad", type: "gallery", ownerId: "dad", ownerType: "user" });
  grant("user", "dad", "audio", "viewer");
  grant("user", "dad", "books", "viewer");
  grant("user", "dad", "pics", "viewer");
  makeItem("a1", "audio", "audiobook");
  makeItem("a2", "audio", "audiobook");
  makeItem("e1", "books", "ebook");
  makeItem("p1", "pics", "gallery");
  booted = await bootApp({ plugins: [homePlugin] });
});

afterEach(async () => {
  await booted.app.close();
});

const counts = async (user: string) => {
  const res = await booted.app.inject({ method: "GET", url: "/api/home/libraries", headers: { cookie: await booted.signIn(user) } });
  expect(res.statusCode).toBe(200);
  return res.json();
};

describe("library counts", () => {
  it("count what this person can see", async () => {
    expect(await counts("dad")).toEqual({ audiobooks: 2, ebooks: 1, photos: 1 });
  });

  it("are all zero for someone with no access", async () => {
    expect(await counts("mum")).toEqual({ audiobooks: 0, ebooks: 0, photos: 0 });
  });

  it("leave out what has been deleted", async () => {
    db.prepare("UPDATE library_items SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = 'a2'").run();
    expect((await counts("dad")).audiobooks).toBe(1);
  });

  it("need a signed-in person", async () => {
    const res = await booted.app.inject({ method: "GET", url: "/api/home/libraries" });
    expect(res.statusCode).toBe(401);
  });
});

describe("the Continue feed", () => {
  it("says when each book was last touched, newest first", () => {
    const played = db.prepare("INSERT INTO playback_progress (id, user_id, item_id, percent_complete, updated_at) VALUES (?, 'dad', ?, 0.5, ?)");
    played.run("p1", "a1", "2026-10-01T10:00:00.000Z");
    played.run("p2", "a2", "2026-10-02T10:00:00.000Z");
    const { items } = inProgress({ id: "dad", role: "member" }, 10, 0);
    expect(items.map((item) => [item.id, item.lastActivityAt])).toEqual([
      ["a2", "2026-10-02T10:00:00.000Z"],
      ["a1", "2026-10-01T10:00:00.000Z"]
    ]);
  });
});

describe("the Orbit theme", () => {
  it("can be chosen", () => {
    expect(THEME_PREFERENCES).toContain("orbit");
    expect(THEME_PREFERENCES).toContain("thanksgiving");
  });

  it("reaches the apps by its own name", () => {
    const headers = identityHeaders(
      { id: "dad", display_name: "Dad", role: "member", language: "en", theme: "orbit" } as never,
      "secret",
      { ip: "127.0.0.1", requestId: "r" }
    );
    expect(headers["x-isputnik-user-theme"]).toBe("orbit");
  });

  it("sends Thanksgiving to the apps the same way", () => {
    const headers = identityHeaders(
      { id: "dad", display_name: "Dad", role: "member", language: "en", theme: "thanksgiving" } as never,
      "secret",
      { ip: "127.0.0.1", requestId: "r" }
    );
    expect(headers["x-isputnik-user-theme"]).toBe("thanksgiving");
  });
});
