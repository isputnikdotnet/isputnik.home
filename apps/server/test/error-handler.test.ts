import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";

import { registerErrorHandler } from "../src/core/error-handler.js";

// The global error handler once answered 500 for everything, so the rate limiter's
// 429 (and Fastify's own 413/400) reached clients as "Unexpected server error" and
// were logged at `error`. These go through the real plugin, the way index.ts wires it.

let app: FastifyInstance;

async function build(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false, bodyLimit: 64 });
  registerErrorHandler(instance);
  await instance.register(rateLimit, { max: 1, timeWindow: "1 minute" });
  instance.post("/echo", async (request) => ({ got: request.body }));
  instance.get("/limited", async () => ({ ok: true }));
  instance.get("/boom", async () => {
    throw new Error("secret internal detail");
  });
  instance.get("/gone", async () => {
    throw Object.assign(new Error("That item is gone."), { statusCode: 404 });
  });
  instance.post(
    "/validated",
    { schema: { body: { type: "object", required: ["name"], properties: { name: { type: "string" } } } }, config: { rateLimit: false } },
    async () => ({ ok: true })
  );
  return instance;
}

afterEach(async () => {
  await app?.close();
});

describe("global error handler", () => {
  it("passes the rate limiter's 429 through, with retry-after", async () => {
    app = await build();
    expect((await app.inject({ method: "GET", url: "/limited" })).statusCode).toBe(200);
    const res = await app.inject({ method: "GET", url: "/limited" });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(res.json().error).toMatch(/rate limit/i);
  });

  it("answers 413 for a body over the limit", async () => {
    app = await build();
    const res = await app.inject({ method: "POST", url: "/echo", payload: { text: "x".repeat(200) } });
    expect(res.statusCode).toBe(413);
  });

  it("answers 400 for malformed JSON", async () => {
    app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json" },
      payload: "{not json"
    });
    expect(res.statusCode).toBe(400);
  });

  it("answers 400 for a schema validation failure", async () => {
    app = await build();
    const res = await app.inject({ method: "POST", url: "/validated", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("keeps an app error's own client status and message", async () => {
    app = await build();
    const res = await app.inject({ method: "GET", url: "/gone" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "That item is gone." });
  });

  it("still hides a real fault behind a generic 500", async () => {
    app = await build();
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "Unexpected server error" });
    expect(res.body).not.toContain("secret");
  });
});
