import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { registerCompression } from "../src/core/compression.js";

// Regression cover for the whole reason this hook is hand-rolled and
// synchronous. @fastify/compress returned a stream from onSend, and every
// handler shaped like
//
//     async (request, reply) => { reply.send(payload); }     // no return
//
// answered 200 with content-encoding set, content-length 0 and an empty body.
// 847 handlers in this codebase are shaped exactly like that, so the very first
// test here is the one that matters: it must never regress to an empty body.

const big = { rows: Array.from({ length: 200 }, (_, i) => ({ i, name: `a long enough value to pass the threshold ${i}` })) };
const bigJson = JSON.stringify(big);

let app: FastifyInstance;

beforeEach(async () => {
  app = Fastify();
  registerCompression(app);

  // Every handler shape the codebase actually uses.
  app.get("/async-bare", async (_request, reply) => { reply.send(big); });
  app.get("/async-return", async (_request, reply) => reply.send(big));
  app.get("/async-value", async () => big);
  app.get("/sync-bare", (_request, reply) => { reply.send(big); });

  app.get("/small", async () => ({ ok: true }));
  app.get("/no-content", async (_request, reply) => { reply.code(204).send(); });
  app.get("/not-modified", async (_request, reply) => { reply.code(304).send(); });
  app.get("/binary", async (_request, reply) => {
    reply.type("image/jpeg").send(Buffer.alloc(4096, 7));
  });
  app.get("/pre-encoded", async (_request, reply) => {
    reply.header("content-encoding", "br").type("application/json").send(Buffer.from(bigJson));
  });
  app.get("/with-etag", async (_request, reply) => {
    reply.header("etag", '"abc123"').send(big);
  });
  app.get("/with-vary", async (_request, reply) => {
    reply.header("vary", "Origin").send(big);
  });
  await app.ready();
});

afterEach(async () => { await app.close(); });

const get = (url: string, encoding = "br, gzip", method: "GET" | "HEAD" = "GET") =>
  app.inject({ method, url, headers: { "accept-encoding": encoding } });

describe("compression: the handler shapes", () => {
  // The one that regressed.
  it("compresses a bare reply.send() in an async handler without truncating it", async () => {
    const res = await get("/async-bare");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
    expect(res.rawPayload.length).toBeGreaterThan(0);
    expect(JSON.parse(brotliDecompressSync(res.rawPayload).toString())).toEqual(big);
  });

  it.each(["/async-return", "/async-value", "/sync-bare"])("round-trips %s", async (url) => {
    const res = await get(url);
    expect(res.headers["content-encoding"]).toBe("br");
    expect(JSON.parse(brotliDecompressSync(res.rawPayload).toString())).toEqual(big);
  });

  it("actually shrinks the payload", async () => {
    const res = await get("/async-value");
    expect(res.rawPayload.length).toBeLessThan(bigJson.length / 5);
    expect(Number(res.headers["content-length"])).toBe(res.rawPayload.length);
  });
});

describe("compression: what it declines to touch", () => {
  it("leaves a payload under the 1 KB threshold alone", async () => {
    const res = await get("/small");
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.json()).toEqual({ ok: true });
  });

  it("leaves already-compressed content types alone", async () => {
    const res = await get("/binary");
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.rawPayload.length).toBe(4096);
  });

  it("never double-encodes a response that set its own encoding", async () => {
    const res = await get("/pre-encoded");
    expect(res.headers["content-encoding"]).toBe("br");
    expect(res.rawPayload.toString()).toBe(bigJson);
  });

  it("leaves bodiless responses alone", async () => {
    expect((await get("/no-content")).headers["content-encoding"]).toBeUndefined();
    expect((await get("/not-modified")).headers["content-encoding"]).toBeUndefined();
  });

  // Fastify exposes HEAD for every GET automatically, so this exercises the
  // real pairing rather than a route invented for the test.
  it("leaves a HEAD reply alone", async () => {
    const res = await get("/async-value", "br, gzip", "HEAD");
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.rawPayload.length).toBe(0);
  });

  it("sends identity when the client accepts nothing it can offer", async () => {
    const res = await get("/async-value", "identity");
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.json()).toEqual(big);
  });
});

describe("compression: negotiation and cache headers", () => {
  it("prefers brotli, falls back to gzip", async () => {
    expect((await get("/async-value", "gzip, br")).headers["content-encoding"]).toBe("br");
    const gz = await get("/async-value", "gzip");
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(JSON.parse(gunzipSync(gz.rawPayload).toString())).toEqual(big);
  });

  it("honours q=0 as a refusal rather than matching on the name", async () => {
    const res = await get("/async-value", "br;q=0, gzip");
    expect(res.headers["content-encoding"]).toBe("gzip");
  });

  it("accepts a wildcard", async () => {
    expect((await get("/async-value", "*")).headers["content-encoding"]).toBe("br");
  });

  it("adds Vary: accept-encoding so a proxy cannot cross-serve encodings", async () => {
    expect((await get("/async-value")).headers.vary).toContain("accept-encoding");
  });

  it("keeps an existing Vary field rather than replacing it", async () => {
    const vary = String((await get("/with-vary")).headers.vary);
    expect(vary).toContain("Origin");
    expect(vary).toContain("accept-encoding");
  });

  it("makes the ETag encoding-specific, since the bytes differ", async () => {
    expect((await get("/with-etag")).headers.etag).toBe('"abc123-br"');
  });
});
