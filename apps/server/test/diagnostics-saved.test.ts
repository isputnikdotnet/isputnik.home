// Saved diagnostics reports (modules/diagnostics/saved.ts): an admin keeps the
// report text as they saved it; the last 10 are kept, and a part's page lists
// only the reports that carry it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diagnosticsPlugin } from "../src/modules/diagnostics/index.js";
import { bootApp, type BootedApp } from "./helpers/boot.js";
import { makeUser, resetDb } from "./helpers/seed.js";

let booted: BootedApp | null = null;

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("kid", "member");
  booted = await bootApp({ plugins: [[diagnosticsPlugin, { settings: { video: { upstream: "", secret: "" }, games: { upstream: "", secret: "" }, faces: { upstream: "", secret: "" } } }]] });
});

afterEach(async () => {
  await booted?.app.close();
  booted = null;
});

const call = async (who: string, method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
  booted!.app.inject({ method, url, payload, headers: { cookie: await booted!.signIn(who) } });

const body = (text: string, parts = ["system", "container:video"]) => ({ text, span: "day", parts, hidden: ["people", "paths"] });

describe("saved reports", () => {
  it("are for an admin, and keep the text exactly as saved", async () => {
    expect((await call("kid", "POST", "/api/admin/diagnostics/saved", body("x"))).statusCode).toBe(403);
    expect((await call("kid", "GET", "/api/admin/diagnostics/saved")).statusCode).toBe(403);

    const saved = await call("admin", "POST", "/api/admin/diagnostics/saved", body("## isputnik.home\nversion: 4.90.0\n"));
    expect(saved.statusCode).toBe(201);
    const { report } = saved.json();
    expect(report).toMatchObject({ span: "day", parts: ["system", "container:video"], hidden: ["people", "paths"], createdBy: "admin", sizeBytes: 33 });
    expect(report.text).toBeUndefined();

    const list = (await call("admin", "GET", "/api/admin/diagnostics/saved")).json();
    expect(list.kept).toBe(10);
    expect(list.reports.map((entry: { id: string }) => entry.id)).toEqual([report.id]);

    const one = (await call("admin", "GET", `/api/admin/diagnostics/saved/${report.id}`)).json();
    expect(one.report.text).toBe("## isputnik.home\nversion: 4.90.0\n");

    expect((await call("admin", "DELETE", `/api/admin/diagnostics/saved/${report.id}`)).statusCode).toBe(200);
    expect((await call("admin", "GET", `/api/admin/diagnostics/saved/${report.id}`)).statusCode).toBe(404);
    expect((await call("admin", "DELETE", `/api/admin/diagnostics/saved/${report.id}`)).statusCode).toBe(404);
  });

  it("refuses a report it can't read", async () => {
    expect((await call("admin", "POST", "/api/admin/diagnostics/saved", { ...body(""), text: "" })).statusCode).toBe(400);
    expect((await call("admin", "POST", "/api/admin/diagnostics/saved", { ...body("x"), span: "year" })).statusCode).toBe(400);
    expect((await call("admin", "POST", "/api/admin/diagnostics/saved", { ...body("x"), hidden: ["secrets"] })).statusCode).toBe(400);
  });

  it("keeps the last 10, newest first", async () => {
    for (let n = 1; n <= 12; n++) await call("admin", "POST", "/api/admin/diagnostics/saved", body(`report ${n}`));
    const { reports } = (await call("admin", "GET", "/api/admin/diagnostics/saved")).json();
    expect(reports).toHaveLength(10);
    const texts = await Promise.all(reports.map(async (entry: { id: string }) => (await call("admin", "GET", `/api/admin/diagnostics/saved/${entry.id}`)).json().report.text));
    expect(texts[0]).toBe("report 12");
    expect(texts.at(-1)).toBe("report 3");
  });

  it("lists only a part's reports on that part's page", async () => {
    await call("admin", "POST", "/api/admin/diagnostics/saved", body("home only", ["system"]));
    await call("admin", "POST", "/api/admin/diagnostics/saved", body("with video", ["system", "container:video"]));
    const video = (await call("admin", "GET", "/api/admin/diagnostics/saved?part=container:video")).json();
    expect(video.reports).toHaveLength(1);
    expect(video.reports[0].parts).toContain("container:video");
  });
});
