// The upload primitive every file-accepting route stands on (modules/uploads):
// backups, audiobook and ebook uploads, gallery uploads and the public drop link.
// Its contract is small and all of it is load-bearing:
//
//   * the caller's policy decides — extension allow-list, and a size cap enforced
//     WHILE streaming (the client's Content-Length is never trusted), which means
//     @fastify/multipart's own 1 MiB default has to be lifted or every photo over a
//     megabyte fails;
//   * the file lands in a temp file under the caller's folder, named by the server,
//     never by the client — a filename is sanitised to its basename and is only
//     ever returned as data;
//   * every failure removes what it wrote, and a batch is all-or-nothing, so a
//     caller never has to clean up after a refusal.
//
// Driven through a throwaway route with the same multipart registration as
// index.ts, so busboy parses exactly what a browser (or a hostile client) sends.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { receiveUpload, receiveUploadBatch, UploadError, type UploadPolicy } from "../src/modules/uploads/index.js";
import { multipart as body } from "./helpers/multipart.js";

let base: string;
let dest: string;
let policy: UploadPolicy;
let app: FastifyInstance;

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-receive-"));
  dest = path.join(base, "incoming");
  policy = { accept: ["jpg", "png"], maxBytes: 1000 };

  app = Fastify();
  // Exactly index.ts's registration: one file per request unless a batch lifts it.
  await app.register(multipart, { limits: { files: 1, fields: 10, fieldSize: 100 * 1024 } });
  const answer = async (work: () => Promise<unknown>) => {
    try {
      return { status: 200, body: await work() };
    } catch (err) {
      if (err instanceof UploadError) return { status: err.statusCode, body: { error: err.message } };
      throw err;
    }
  };
  app.post("/single", async (request, reply) => {
    const { status, body: sent } = await answer(() => receiveUpload(request, policy, dest));
    return reply.code(status).send(sent);
  });
  app.post("/batch", async (request, reply) => {
    const max = Number((request.query as { max?: string }).max ?? 5);
    const { status, body: sent } = await answer(() => receiveUploadBatch(request, policy, dest, max));
    return reply.code(status).send(sent);
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  fs.rmSync(base, { recursive: true, force: true });
});

const send = (url: string, parts: Parameters<typeof body>[0]) => {
  const { payload, headers } = body(parts);
  return app.inject({ method: "POST", url, payload, headers });
};

/** Everything under the test's temp folder, relative — to prove nothing leaked. */
function everythingOnDisk(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(base, full).split(path.sep).join("/"));
    }
  };
  walk(base);
  return out.sort();
}

describe("a single upload", () => {
  it("streams the file into a server-named temp file and reports what arrived", async () => {
    const res = await send("/single", [{ filename: "Holiday.JPG", data: Buffer.alloc(600, 7) }]);

    expect(res.statusCode).toBe(200);
    const received = res.json() as { tmpPath: string; filename: string; extension: string; sizeBytes: number };
    expect(received).toMatchObject({ filename: "Holiday.JPG", extension: "jpg", sizeBytes: 600 });
    expect(path.dirname(received.tmpPath)).toBe(dest);
    expect(path.basename(received.tmpPath)).toMatch(/^\.upload-[\w-]{12}\.jpg$/);
    expect(fs.readFileSync(received.tmpPath)).toEqual(Buffer.alloc(600, 7));
  });

  it("refuses a request that isn't multipart", async () => {
    const res = await app.inject({ method: "POST", url: "/single", payload: { file: "nope" } });

    expect(res.statusCode).toBe(415);
    expect(res.json().error).toMatch(/multipart/);
  });

  it("refuses a multipart request with no file in it", async () => {
    const res = await send("/single", [{ name: "note", data: "just a field" }]);

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("No file was uploaded.");
  });

  it.each([
    ["run.exe"],
    ["page.html"],
    ["photo.jpg.exe"],
    ["shell.php"],
    ["no-extension"],
    [".jpg"] // a dotfile: all name, no extension
  ])("refuses %s: not on the allow-list", async (filename) => {
    const res = await send("/single", [{ filename, data: "MZ-not-a-photo" }]);

    expect(res.statusCode).toBe(415);
    expect(res.json().error).toMatch(/Unsupported file type/);
    expect(everythingOnDisk()).toEqual([]);
  });

  it("refuses a file one byte over the cap and leaves nothing behind", async () => {
    const res = await send("/single", [{ filename: "big.jpg", data: Buffer.alloc(1001) }]);

    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatch(/larger than the 1 KB limit/);
    expect(everythingOnDisk()).toEqual([]);
  });

  it("keeps a file exactly at the cap", async () => {
    const res = await send("/single", [{ filename: "edge.png", data: Buffer.alloc(1000) }]);

    expect(res.statusCode).toBe(200);
    expect(res.json().sizeBytes).toBe(1000);
  });

  it("stops a file far over the cap while it streams", async () => {
    // Multipart parts carry no trustworthy size, so the count of bytes actually
    // read is the only rule — and the stream is cut, not read to the end.
    policy = { accept: ["jpg"], maxBytes: 4096 };
    const res = await send("/single", [{ filename: "liar.jpg", contentType: "image/jpeg", data: Buffer.alloc(64 * 1024) }]);

    expect(res.statusCode).toBe(413);
    expect(everythingOnDisk()).toEqual([]);
  });

  it("takes a file over a megabyte when the policy allows it", async () => {
    // @fastify/multipart caps a file at fastify's 1 MiB bodyLimit unless told
    // otherwise; the receiver lifts it so the policy is the only size rule. Without
    // that, every real photo fails with a truncated-file error.
    policy = { accept: ["jpg"], maxBytes: null };
    const res = await send("/single", [{ filename: "camera.jpg", data: Buffer.alloc(3 * 1024 * 1024, 1) }]);

    expect(res.statusCode).toBe(200);
    expect(res.json().sizeBytes).toBe(3 * 1024 * 1024);
  });

  it("refuses an empty file and leaves nothing behind", async () => {
    const res = await send("/single", [{ filename: "empty.jpg", data: Buffer.alloc(0) }]);

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/is empty/);
    expect(everythingOnDisk()).toEqual([]);
  });
});

describe("what a filename may do", () => {
  it.each([
    ["../../../evil.jpg"],
    ["..\\..\\..\\evil.jpg"],
    ["/etc/cron.d/evil.jpg"],
    ["C:\\Windows\\System32\\evil.jpg"],
    ["incoming/../../evil.jpg"]
  ])("keeps %s inside the upload folder, as its basename", async (filename) => {
    const res = await send("/single", [{ filename, data: "x".repeat(10) }]);

    expect(res.statusCode).toBe(200);
    const received = res.json() as { tmpPath: string; filename: string };
    expect(received.filename).toBe("evil.jpg");
    expect(path.dirname(received.tmpPath)).toBe(dest);
    // The only file anywhere under the temp root is the one in the upload folder.
    expect(everythingOnDisk()).toEqual([`incoming/${path.basename(received.tmpPath)}`]);
  });

  it("strips characters no filesystem wants, and keeps the ones people use", async () => {
    const hostile = await send("/single", [{ filename: "a*b?c<d>e|f.jpg", data: "x" }]);
    expect(hostile.json().filename).toBe("a_b_c_d_e_f.jpg");

    // Unicode survives: audiobook track names become chapter titles.
    const russian = await send("/single", [{ filename: "Глава 01.jpg", data: "x" }]);
    expect(russian.json().filename).toBe("Глава 01.jpg");
  });
});

describe("a batch", () => {
  it("takes several files, each in its own temp file", async () => {
    const res = await send("/batch?max=3", [
      { filename: "one.jpg", data: "1111" },
      { filename: "two.png", data: "22" }
    ]);

    expect(res.statusCode).toBe(200);
    const received = res.json() as { filename: string; sizeBytes: number; tmpPath: string }[];
    expect(received.map((file) => [file.filename, file.sizeBytes])).toEqual([["one.jpg", 4], ["two.png", 2]]);
    expect(new Set(received.map((file) => file.tmpPath)).size).toBe(2);
  });

  it("refuses more files than the caller allows, keeping none of them", async () => {
    const res = await send("/batch?max=2", [
      { filename: "1.jpg", data: "a" },
      { filename: "2.jpg", data: "b" },
      { filename: "3.jpg", data: "c" }
    ]);

    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatch(/at most 2/);
    expect(everythingOnDisk()).toEqual([]);
  });

  it("drops the files already received when a later one is refused", async () => {
    const wrongType = await send("/batch", [
      { filename: "good.jpg", data: "fine" },
      { filename: "bad.exe", data: "MZ" }
    ]);
    expect(wrongType.statusCode).toBe(415);
    expect(everythingOnDisk()).toEqual([]);

    const tooBig = await send("/batch", [
      { filename: "good.jpg", data: "fine" },
      { filename: "huge.jpg", data: Buffer.alloc(5000) }
    ]);
    expect(tooBig.statusCode).toBe(413);
    expect(everythingOnDisk()).toEqual([]);
  });

  it("refuses a batch with no files in it", async () => {
    const res = await send("/batch", [{ name: "note", data: "hello" }]);

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("No files were uploaded.");
  });
});
