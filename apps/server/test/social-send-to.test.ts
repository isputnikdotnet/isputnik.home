import { beforeEach, describe, expect, it, vi } from "vitest";

// Sending mails the recipient when the admin has switched it on; keep it off the
// wire and make the gate answer "no" so the tests exercise the in-app path only.
vi.mock("../src/core/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/mail.js")>();
  return { ...actual, sendMail: vi.fn(async () => {}), isMailConfigured: () => false };
});

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";

import { db } from "../src/db.js";
import { hashPassword } from "../src/crypto.js";
import { registerAuthDecorators } from "../src/auth.js";
import { socialPlugin } from "../src/modules/social/routes.js";
import { grant, makeLibrary, resetDb } from "./helpers/seed.js";

// "Send to" is a POINTER, not a copy, and the recipient opens it with their own
// access. Everything below is a way of asking whether that promise holds: the
// sheet must not offer someone who can't open the thing, the send must refuse
// when they can't, and the card must survive the thing going away.

const PASSWORD = "correct-horse-battery";

let app: FastifyInstance;

async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(cookie);
  await registerAuthDecorators(instance);
  await instance.register(socialPlugin);

  instance.post("/test/sign-in/:userId", async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const { issueSession } = await import("../src/auth.js");
    issueSession(reply, userId, request);
    return reply.send({ ok: true });
  });

  await instance.ready();
  return instance;
}

async function makeMember(id: string, role: "admin" | "member" = "member"): Promise<string> {
  db.prepare("INSERT INTO users (id, email, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)")
    .run(id, `${id}@test.local`, await hashPassword(PASSWORD), id, role);
  return id;
}

async function signIn(userId: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: `/test/sign-in/${userId}` });
  const raw = response.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : [String(raw)];
  const found = list.find((entry) => entry.startsWith("isputnik_sid="));
  if (!found) throw new Error("no session cookie was set");
  return found.split(";")[0];
}

// A library the given users can see, holding one ebook. The creator is a manager
// so they can widen access; `viewers` get view-only.
function makeEbook(
  itemId: string,
  libraryId: string,
  opts: { createdBy: string; viewers: string[]; curators?: string[] }
): void {
  makeLibrary(libraryId, { createdBy: opts.createdBy, type: "ebook", ownerId: opts.createdBy, ownerType: "user" });
  grant("user", opts.createdBy, libraryId, "manager");
  for (const curator of opts.curators ?? []) grant("user", curator, libraryId, "manager");
  for (const viewer of opts.viewers.filter((v) => v !== opts.createdBy)) grant("user", viewer, libraryId, "viewer");
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path) VALUES (?, ?, ?, ?)")
    .run(itemId, libraryId, "ebook", `/src/${libraryId}/${itemId}`);
  db.prepare("INSERT INTO item_metadata (item_id, title) VALUES (?, ?)").run(itemId, "The Hobbit");
}

beforeEach(async () => {
  resetDb();
  app = await buildApp();
});

describe("destinations", () => {
  it("lists everybody, marking who cannot open it yet", async () => {
    await makeMember("dad");
    await makeMember("mom");
    await makeMember("guest");
    makeEbook("book-1", "lib-1", { createdBy: "dad", viewers: ["dad", "mom"] });

    const session = await signIn("dad");
    const response = await app.inject({
      method: "GET",
      url: "/api/social/destinations?entityType=ebook&entityId=book-1",
      headers: { cookie: session }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      people: { id: string; canOpen: boolean }[];
      subject: { title: string };
      canGrant: boolean;
    };
    expect(body.subject.title).toBe("The Hobbit");
    // Dad is never offered himself. Guest is listed but flagged: hiding people who
    // lack access is what used to push you into a separate Share dialog.
    expect(body.people).toEqual([
      { id: "guest", displayName: "guest", alreadySent: false, canOpen: false },
      { id: "mom", displayName: "mom", alreadySent: false, canOpen: true }
    ]);
    expect(body.canGrant).toBe(true);
  });

  it("says the caller may not widen access when they only have view rights", async () => {
    await makeMember("dad");
    await makeMember("mom");
    await makeMember("guest");
    makeEbook("book-1", "lib-1", { createdBy: "dad", viewers: ["dad", "mom"] });

    const session = await signIn("mom");
    const response = await app.inject({
      method: "GET",
      url: "/api/social/destinations?entityType=ebook&entityId=book-1",
      headers: { cookie: session }
    });

    const body = response.json() as { canGrant: boolean; people: { id: string; canOpen: boolean }[] };
    expect(body.canGrant).toBe(false);
    // She still SEES that guest is missing — she just cannot be the one to fix it.
    expect(body.people.find((p) => p.id === "guest")?.canOpen).toBe(false);
  });

  it("never offers to grant access to a family-tree person", async () => {
    await makeMember("dad");
    await makeMember("mom");
    db.prepare("INSERT INTO family_tree_persons (id, name) VALUES ('p1', 'Grandma')").run();

    const session = await signIn("dad");
    const response = await app.inject({
      method: "GET",
      url: "/api/social/destinations?entityType=family_tree_person&entityId=p1",
      headers: { cookie: session }
    });

    const body = response.json() as { canGrant: boolean; people: { canOpen: boolean }[] };
    // Everyone signed in can already read the tree, so there is nothing to widen.
    expect(body.canGrant).toBe(false);
    expect(body.people.every((p) => p.canOpen)).toBe(true);
  });

  it("offers the caller's own e-reader for books, and says when it isn't set up", async () => {
    await makeMember("dad");
    makeEbook("book-1", "lib-1", { createdBy: "dad", viewers: ["dad"] });
    const session = await signIn("dad");

    const before = await app.inject({
      method: "GET",
      url: "/api/social/destinations?entityType=ebook&entityId=book-1",
      headers: { cookie: session }
    });
    expect(before.json().ereader).toEqual({ applicable: true, configured: false });

    db.prepare("UPDATE users SET ereader_email = ? WHERE id = 'dad'").run("dad@kindle.com");
    const after = await app.inject({
      method: "GET",
      url: "/api/social/destinations?entityType=ebook&entityId=book-1",
      headers: { cookie: session }
    });
    expect(after.json().ereader).toEqual({ applicable: true, configured: true });
  });

  it("does not offer an e-reader for something that isn't a book", async () => {
    await makeMember("dad");
    makeLibrary("lib-g", { createdBy: "dad", type: "gallery", ownerId: "dad", ownerType: "user" });
    grant("user", "dad", "lib-g", "viewer");
    db.prepare("INSERT INTO library_items (id, library_id, type, folder_path) VALUES (?, ?, ?, ?)")
      .run("photo-1", "lib-g", "gallery", "/src/lib-g/photo-1.jpg");

    const session = await signIn("dad");
    const response = await app.inject({
      method: "GET",
      url: "/api/social/destinations?entityType=gallery&entityId=photo-1",
      headers: { cookie: session }
    });
    expect(response.json().ereader.applicable).toBe(false);
  });

  it("404s a subject the caller cannot see, rather than describing it", async () => {
    await makeMember("dad");
    await makeMember("guest");
    makeEbook("book-1", "lib-1", { createdBy: "dad", viewers: ["dad"] });

    const session = await signIn("guest");
    const response = await app.inject({
      method: "GET",
      url: "/api/social/destinations?entityType=ebook&entityId=book-1",
      headers: { cookie: session }
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("sending", () => {
  it("lands in the recipient's inbox with the sender's line", async () => {
    await makeMember("dad");
    await makeMember("mom");
    makeEbook("book-1", "lib-1", { createdBy: "dad", viewers: ["dad", "mom"] });

    const dadSession = await signIn("dad");
    const send = await app.inject({
      method: "POST",
      url: "/api/social/recommendations",
      headers: { cookie: dadSession },
      payload: { entityType: "ebook", entityId: "book-1", toUserIds: ["mom"], message: "you'll love this" }
    });
    expect(send.statusCode).toBe(201);

    const momSession = await signIn("mom");
    const inbox = await app.inject({ method: "GET", url: "/api/social/inbox", headers: { cookie: momSession } });
    const items = inbox.json().items as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "The Hobbit",
      message: "you'll love this",
      fromName: "dad",
      status: "new",
      available: true,
      savable: true
    });
  });

  it("refuses to send something the recipient cannot open, unless asked to grant", async () => {
    await makeMember("dad");
    await makeMember("guest");
    makeEbook("book-1", "lib-1", { createdBy: "dad", viewers: ["dad"] });

    const session = await signIn("dad");
    const response = await app.inject({
      method: "POST",
      url: "/api/social/recommendations",
      headers: { cookie: session },
      payload: { entityType: "ebook", entityId: "book-1", toUserIds: ["guest"] }
    });

    // No grantAccess flag: the access is NOT widened as a side effect of sending.
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toContain("guest");
    expect(db.prepare("SELECT COUNT(*) AS n FROM recommendations").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM shares").get()).toEqual({ n: 0 });
  });

  it("grants access on the way through when the sender asks and may", async () => {
    await makeMember("dad");
    await makeMember("guest");
    makeEbook("book-1", "lib-1", { createdBy: "dad", viewers: ["dad"] });

    const session = await signIn("dad");
    const response = await app.inject({
      method: "POST",
      url: "/api/social/recommendations",
      headers: { cookie: session },
      payload: {
        entityType: "ebook",
        entityId: "book-1",
        toUserIds: ["guest"],
        grantAccess: true,
        message: "have a look"
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ sent: ["guest"], granted: ["guest"] });

    // One share row, and the card is openable by its recipient.
    const shares = db.prepare("SELECT module, resource_id, user_id, permission FROM shares").all();
    expect(shares).toEqual([
      { module: "ebook", resource_id: "book-1", user_id: "guest", permission: "read" }
    ]);

    const guestSession = await signIn("guest");
    const inbox = await app.inject({ method: "GET", url: "/api/social/inbox", headers: { cookie: guestSession } });
    expect((inbox.json().items as Record<string, unknown>[])[0]).toMatchObject({
      available: true,
      title: "The Hobbit"
    });
  });

  it("will not let a view-only member widen access by asking nicely", async () => {
    await makeMember("dad");
    await makeMember("mom");
    await makeMember("guest");
    makeEbook("book-1", "lib-1", { createdBy: "dad", viewers: ["dad", "mom"] });

    const session = await signIn("mom");
    const response = await app.inject({
      method: "POST",
      url: "/api/social/recommendations",
      headers: { cookie: session },
      payload: { entityType: "ebook", entityId: "book-1", toUserIds: ["guest"], grantAccess: true }
    });

    expect(response.statusCode).toBe(403);
    expect(db.prepare("SELECT COUNT(*) AS n FROM shares").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM recommendations").get()).toEqual({ n: 0 });
  });

  it("does not grant anything for a subject that has no access to grant", async () => {
    await makeMember("dad");
    await makeMember("mom");
    db.prepare("INSERT INTO family_tree_persons (id, name) VALUES ('p1', 'Grandma')").run();

    const session = await signIn("dad");
    const response = await app.inject({
      method: "POST",
      url: "/api/social/recommendations",
      headers: { cookie: session },
      payload: { entityType: "family_tree_person", entityId: "p1", toUserIds: ["mom"], grantAccess: true }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().granted).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM shares").get()).toEqual({ n: 0 });
  });

  it("re-sending the same thing updates the card instead of stacking duplicates", async () => {
    await makeMember("dad");
    await makeMember("mom");
    makeEbook("book-1", "lib-1", { createdBy: "dad", viewers: ["dad", "mom"] });
    const session = await signIn("dad");

    const send = (message: string) => app.inject({
      method: "POST",
      url: "/api/social/recommendations",
      headers: { cookie: session },
      payload: { entityType: "ebook", entityId: "book-1", toUserIds: ["mom"], message }
    });

    await send("first thought");
    await send("actually, this bit");

    const rows = db.prepare("SELECT message, status FROM recommendations").all();
    expect(rows).toEqual([{ message: "actually, this bit", status: "new" }]);
  });

  it("lifts a dismissed card back to new when it is sent again", async () => {
    await makeMember("dad");
    await makeMember("mom");
    makeEbook("book-1", "lib-1", { createdBy: "dad", viewers: ["dad", "mom"] });
    const dadSession = await signIn("dad");
    const momSession = await signIn("mom");

    await app.inject({
      method: "POST", url: "/api/social/recommendations", headers: { cookie: dadSession },
      payload: { entityType: "ebook", entityId: "book-1", toUserIds: ["mom"] }
    });
    const id = (db.prepare("SELECT id FROM recommendations").get() as { id: string }).id;
    await app.inject({ method: "POST", url: `/api/social/recommendations/${id}/dismiss`, headers: { cookie: momSession } });
    expect((db.prepare("SELECT status FROM recommendations").get() as { status: string }).status).toBe("dismissed");

    await app.inject({
      method: "POST", url: "/api/social/recommendations", headers: { cookie: dadSession },
      payload: { entityType: "ebook", entityId: "book-1", toUserIds: ["mom"], message: "no really" }
    });
    expect((db.prepare("SELECT status FROM recommendations").get() as { status: string }).status).toBe("new");
  });

  it("will not send to yourself", async () => {
    await makeMember("dad");
    makeEbook("book-1", "lib-1", { createdBy: "dad", viewers: ["dad"] });
    const session = await signIn("dad");

    const response = await app.inject({
      method: "POST",
      url: "/api/social/recommendations",
      headers: { cookie: session },
      payload: { entityType: "ebook", entityId: "book-1", toUserIds: ["dad"] }
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("the inbox", () => {
  async function sendHobbitToMom(): Promise<{ id: string; momSession: string }> {
    await makeMember("dad");
    await makeMember("mom");
    makeEbook("book-1", "lib-1", { createdBy: "dad", viewers: ["dad", "mom"] });
    const dadSession = await signIn("dad");
    await app.inject({
      method: "POST", url: "/api/social/recommendations", headers: { cookie: dadSession },
      payload: { entityType: "ebook", entityId: "book-1", toUserIds: ["mom"] }
    });
    return {
      id: (db.prepare("SELECT id FROM recommendations").get() as { id: string }).id,
      momSession: await signIn("mom")
    };
  }

  it("the bell counts what has not been looked at, and clears when it is", async () => {
    const { momSession } = await sendHobbitToMom();

    const before = await app.inject({ method: "GET", url: "/api/social/inbox/summary", headers: { cookie: momSession } });
    expect(before.json()).toEqual({ unseen: 1 });

    await app.inject({ method: "POST", url: "/api/social/inbox/seen", headers: { cookie: momSession } });

    const after = await app.inject({ method: "GET", url: "/api/social/inbox/summary", headers: { cookie: momSession } });
    expect(after.json()).toEqual({ unseen: 0 });
  });

  it("saving puts it in My List and leaves no second saved-things list", async () => {
    const { id, momSession } = await sendHobbitToMom();

    const response = await app.inject({
      method: "POST", url: `/api/social/recommendations/${id}/save`, headers: { cookie: momSession }
    });
    expect(response.statusCode).toBe(200);

    const saves = db.prepare("SELECT user_id, item_id FROM item_saves").all();
    expect(saves).toEqual([{ user_id: "mom", item_id: "book-1" }]);
    expect((db.prepare("SELECT status FROM recommendations").get() as { status: string }).status).toBe("saved");
  });

  it("saving twice does not duplicate the My List row", async () => {
    const { id, momSession } = await sendHobbitToMom();
    await app.inject({ method: "POST", url: `/api/social/recommendations/${id}/save`, headers: { cookie: momSession } });
    await app.inject({ method: "POST", url: `/api/social/recommendations/${id}/save`, headers: { cookie: momSession } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM item_saves").get()).toEqual({ n: 1 });
  });

  it("nobody can act on someone else's card", async () => {
    const { id } = await sendHobbitToMom();
    const dadSession = await signIn("dad");

    const save = await app.inject({
      method: "POST", url: `/api/social/recommendations/${id}/save`, headers: { cookie: dadSession }
    });
    const dismiss = await app.inject({
      method: "POST", url: `/api/social/recommendations/${id}/dismiss`, headers: { cookie: dadSession }
    });
    expect(save.statusCode).toBe(404);
    expect(dismiss.statusCode).toBe(404);
  });

  it("keeps the card readable after the subject is gone", async () => {
    const { momSession } = await sendHobbitToMom();
    db.prepare("DELETE FROM library_items WHERE id = 'book-1'").run();

    const inbox = await app.inject({ method: "GET", url: "/api/social/inbox", headers: { cookie: momSession } });
    const card = (inbox.json().items as Record<string, unknown>[])[0];
    // The snapshot carries it: still says what it was about, but offers no link.
    expect(card).toMatchObject({ available: false, title: "The Hobbit", href: "" });
  });

  it("keeps the card readable after the sender's account is removed", async () => {
    const { momSession } = await sendHobbitToMom();
    db.prepare("UPDATE recommendations SET from_user_id = NULL").run();

    const inbox = await app.inject({ method: "GET", url: "/api/social/inbox", headers: { cookie: momSession } });
    const card = (inbox.json().items as Record<string, unknown>[])[0];
    expect(card).toMatchObject({ fromName: "dad" });
  });

  it("hides a card whose library access was taken away", async () => {
    const { momSession } = await sendHobbitToMom();
    db.prepare("DELETE FROM assignments WHERE subject_id = 'mom'").run();

    const inbox = await app.inject({ method: "GET", url: "/api/social/inbox", headers: { cookie: momSession } });
    const card = (inbox.json().items as Record<string, unknown>[])[0];
    expect(card.available).toBe(false);
  });
});

describe("albums and slideshows", () => {
  // An album is visible to anyone who can see a photo in it, so "can you open
  // it" is "is any of it yours to see" — which is also why sending one is worth
  // doing: the recipient gets their share of it, not all of it.
  function makeAlbum(albumId: string, opts: { createdBy: string; itemIds: string[] }): void {
    db.prepare("INSERT INTO gallery_albums (id, name, created_by) VALUES (?, ?, ?)")
      .run(albumId, "Summer 2019", opts.createdBy);
    opts.itemIds.forEach((itemId, index) => {
      db.prepare("INSERT INTO gallery_album_items (album_id, item_id, position) VALUES (?, ?, ?)")
        .run(albumId, itemId, index);
    });
  }

  function makePhoto(itemId: string, libraryId: string, opts: { createdBy: string; viewers: string[] }): void {
    if (!db.prepare("SELECT 1 FROM libraries WHERE id = ?").get(libraryId)) {
      makeLibrary(libraryId, { createdBy: opts.createdBy, type: "gallery", ownerId: opts.createdBy, ownerType: "user" });
      for (const viewer of opts.viewers) grant("user", viewer, libraryId, "viewer");
    }
    db.prepare("INSERT INTO library_items (id, library_id, type, folder_path) VALUES (?, ?, 'gallery', ?)")
      .run(itemId, libraryId, `/src/${libraryId}/${itemId}.jpg`);
  }

  it("describes an album by what the viewer can actually see of it", async () => {
    await makeMember("dad");
    await makeMember("mom");
    makePhoto("p1", "lib-open", { createdBy: "dad", viewers: ["dad", "mom"] });
    makePhoto("p2", "lib-private", { createdBy: "dad", viewers: ["dad"] });
    makeAlbum("alb-1", { createdBy: "dad", itemIds: ["p1", "p2"] });

    const asDad = await app.inject({
      method: "GET",
      url: "/api/social/destinations?entityType=gallery_album&entityId=alb-1",
      headers: { cookie: await signIn("dad") }
    });
    const asMom = await app.inject({
      method: "GET",
      url: "/api/social/destinations?entityType=gallery_album&entityId=alb-1",
      headers: { cookie: await signIn("mom") }
    });

    // Same album, different counts — each sees their share.
    expect(asDad.json().subject).toMatchObject({ title: "Summer 2019", subtitle: "2 photos" });
    expect(asMom.json().subject).toMatchObject({ title: "Summer 2019", subtitle: "1 photo" });
  });

  it("offers a guest link for an album but never for a slideshow", async () => {
    await makeMember("dad");
    makePhoto("p1", "lib-open", { createdBy: "dad", viewers: ["dad"] });
    makeAlbum("alb-1", { createdBy: "dad", itemIds: ["p1"] });
    db.prepare("INSERT INTO gallery_slideshows (id, name, created_by) VALUES ('sl-1', 'Christmas', 'dad')").run();
    const session = await signIn("dad");

    const album = await app.inject({
      method: "GET",
      url: "/api/social/destinations?entityType=gallery_album&entityId=alb-1",
      headers: { cookie: session }
    });
    const slideshow = await app.inject({
      method: "GET",
      url: "/api/social/destinations?entityType=gallery_slideshow&entityId=sl-1",
      headers: { cookie: session }
    });

    expect(album.json().guestLink).toBe(true);
    // A slideshow has no public page to point at, and every signed-in account can
    // already play it — so there is nothing to link and nothing to grant.
    expect(slideshow.json()).toMatchObject({ guestLink: false, canGrant: false });
    expect((slideshow.json().people as { canOpen: boolean }[]).every((p) => p.canOpen)).toBe(true);
  });

  it("grants album access on the way through, using the album's own rule", async () => {
    await makeMember("dad");
    await makeMember("guest");
    makePhoto("p1", "lib-private", { createdBy: "dad", viewers: ["dad"] });
    makeAlbum("alb-1", { createdBy: "dad", itemIds: ["p1"] });

    const response = await app.inject({
      method: "POST",
      url: "/api/social/recommendations",
      headers: { cookie: await signIn("dad") },
      payload: { entityType: "gallery_album", entityId: "alb-1", toUserIds: ["guest"], grantAccess: true }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().granted).toEqual(["guest"]);
    expect(db.prepare("SELECT module, resource_id, user_id FROM shares").all()).toEqual([
      { module: "gallery_album", resource_id: "alb-1", user_id: "guest" }
    ]);
  });

  it("will not let a non-creator widen access to somebody else's album", async () => {
    await makeMember("dad");
    await makeMember("mom");
    await makeMember("guest");
    makePhoto("p1", "lib-open", { createdBy: "dad", viewers: ["dad", "mom"] });
    makeAlbum("alb-1", { createdBy: "dad", itemIds: ["p1"] });

    // mom can SEE the album, so she may send it — but only its creator or an
    // admin may hand out access to it.
    const destinations = await app.inject({
      method: "GET",
      url: "/api/social/destinations?entityType=gallery_album&entityId=alb-1",
      headers: { cookie: await signIn("mom") }
    });
    expect(destinations.json().canGrant).toBe(false);

    const send = await app.inject({
      method: "POST",
      url: "/api/social/recommendations",
      headers: { cookie: await signIn("mom") },
      payload: { entityType: "gallery_album", entityId: "alb-1", toUserIds: ["guest"], grantAccess: true }
    });
    expect(send.statusCode).toBe(403);
    expect(db.prepare("SELECT COUNT(*) AS n FROM shares").get()).toEqual({ n: 0 });
  });

  it("offers no Favorites for an album or a slideshow", async () => {
    await makeMember("dad");
    await makeMember("mom");
    makePhoto("p1", "lib-open", { createdBy: "dad", viewers: ["dad", "mom"] });
    makeAlbum("alb-1", { createdBy: "dad", itemIds: ["p1"] });

    await app.inject({
      method: "POST",
      url: "/api/social/recommendations",
      headers: { cookie: await signIn("dad") },
      payload: { entityType: "gallery_album", entityId: "alb-1", toUserIds: ["mom"] }
    });

    const inbox = await app.inject({ method: "GET", url: "/api/social/inbox", headers: { cookie: await signIn("mom") } });
    const card = (inbox.json().items as Record<string, unknown>[])[0];
    // Nothing to shortlist: a household has tens of albums, all on one page.
    expect(card).toMatchObject({ title: "Summer 2019", savable: false });

    const id = (db.prepare("SELECT id FROM recommendations").get() as { id: string }).id;
    const save = await app.inject({
      method: "POST",
      url: `/api/social/recommendations/${id}/save`,
      headers: { cookie: await signIn("mom") }
    });
    expect(save.statusCode).toBe(400);
  });
});
