// The video page's rows (modules/library/video/home-layout.ts): saved queries the
// household's admin chooses, never titles. The engine is not asked for anything
// here — each screen asks it for a row's titles itself, as the viewer.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { setSections, ALL_SECTIONS_ON } from "../src/core/sections.js";
import { videoPlugin } from "../src/modules/library/video/index.js";
import { bootApp, type BootedApp } from "./helpers/boot.js";
import { makeUser, resetDb } from "./helpers/seed.js";

const SECRET = "video-gateway-secret-0123456789abcdef";
let booted: BootedApp;

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("mum", "member");
  booted = await bootApp({ plugins: [[videoPlugin, { upstream: "http://127.0.0.1:9", secret: SECRET }]] });
});

afterEach(async () => {
  await booted.app.close();
});

const as = async (who: string, method: "GET" | "PUT" | "DELETE", payload?: unknown, query = "") =>
  booted.app.inject({ method, url: `/api/video/home${query}`, payload: payload as never, headers: { cookie: await booted.signIn(who) } });

const rows = [
  { id: "c", type: "continue" },
  { id: "comedy", type: "titles", kind: "all", genres: ["Comedy"], sort: "added" },
  { id: "kids", type: "titles", kind: "movies", libraries: ["lib_kids"], title: "Cartoons", hidden: true }
];

describe("the video page's rows", () => {
  it("are the page as it was until someone changes them", async () => {
    const res = await as("mum", "GET");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ custom: false, editable: false });
    expect(res.json().rows.map((row: { id: string }) => row.id)).toEqual(["continue", "new-movies", "new-shows", "sets"]);
    expect((await as("admin", "GET")).json().editable).toBe(true);
  });

  it("are the admin's to change, for everyone, with what each leaves out filled in", async () => {
    const saved = await as("admin", "PUT", { rows });
    expect(saved.statusCode).toBe(200);
    const page = (await as("mum", "GET")).json();
    expect(page.custom).toBe(true);
    expect(page.rows).toEqual([
      { id: "c", type: "continue" },
      { id: "comedy", type: "titles", kind: "all", libraries: [], genres: ["Comedy"], sort: "added" },
      { id: "kids", type: "titles", kind: "movies", libraries: ["lib_kids"], genres: [], sort: "added", title: "Cartoons", hidden: true }
    ]);
    const logged = db.prepare("SELECT event, actor_user_id FROM activity_logs WHERE event LIKE 'library.video.rows%'").all();
    expect(logged).toHaveLength(1);
  });

  it("go back to the default when reset", async () => {
    await as("admin", "PUT", { rows });
    expect((await as("admin", "DELETE")).json().custom).toBe(false);
    expect((await as("mum", "GET")).json().rows).toHaveLength(4);
  });

  it("are not a member's to change", async () => {
    expect((await as("mum", "PUT", { rows })).statusCode).toBe(403);
    expect((await as("mum", "DELETE")).statusCode).toBe(403);
  });

  it("refuse a row they cannot read, two of one id, or too many", async () => {
    expect((await as("admin", "PUT", { rows: [{ id: "x", type: "everything" }] })).statusCode).toBe(400);
    expect((await as("admin", "PUT", { rows: [{ id: "x", type: "continue" }, { id: "x", type: "sets" }] })).statusCode).toBe(400);
    expect((await as("admin", "PUT", { rows: [{ id: "x", type: "titles", libraries: ["../etc"] }] })).statusCode).toBe(400);
    const many = Array.from({ length: 16 }, (_, n) => ({ id: `r${n}`, type: "continue" }));
    expect((await as("admin", "PUT", { rows: many })).statusCode).toBe(400);
  });

  it("skip a row a later version wrote, rather than failing the page", async () => {
    db.prepare("INSERT INTO video_home_layouts (owner, rows) VALUES ('', ?)").run(JSON.stringify([{ id: "c", type: "continue" }, { id: "n", type: "nextYear" }]));
    expect((await as("mum", "GET")).json().rows).toEqual([{ id: "c", type: "continue" }]);
  });

  it("can be anyone's own, made from the household's and dropped to follow it again", async () => {
    await as("admin", "PUT", { rows });
    const mine = [{ id: "c", type: "continue" }];
    const saved = await as("mum", "PUT", { rows: mine, scope: "mine" });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ mine: true, custom: true, editable: false, rows: mine });
    // Hers alone: the admin's page, and the household's, are as they were.
    expect((await as("admin", "GET")).json()).toMatchObject({ mine: false });
    expect((await as("mum", "GET", undefined, "?scope=everyone")).json().rows).toHaveLength(3);
    // The household changing does not reach her copy…
    await as("admin", "PUT", { rows: [{ id: "s", type: "sets" }] });
    expect((await as("mum", "GET")).json().rows).toEqual(mine);
    // …until she drops it.
    const back = await as("mum", "DELETE", undefined, "?scope=mine");
    expect(back.json()).toMatchObject({ mine: false, rows: [{ id: "s", type: "sets" }] });
    // Nobody's own rows reach the log.
    expect(db.prepare("SELECT COUNT(*) AS n FROM activity_logs WHERE actor_user_id = 'mum'").get()).toEqual({ n: 0 });
  });

  it("go when the person does", async () => {
    await as("mum", "PUT", { rows: [{ id: "c", type: "continue" }], scope: "mine" });
    db.prepare("DELETE FROM users WHERE id = 'mum'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM video_home_user_layouts").get()).toEqual({ n: 0 });
  });

  it("are not there when Video is switched off", async () => {
    setSections({ ...ALL_SECTIONS_ON, video: false }, "admin");
    expect((await as("mum", "GET")).statusCode).toBe(404);
    setSections(ALL_SECTIONS_ON, "admin");
  });
});
