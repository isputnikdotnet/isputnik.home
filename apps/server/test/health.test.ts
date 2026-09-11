import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { healthPlugin } from "../src/core/health.js";

// Docker's HEALTHCHECK polls this with no session, so it must answer without one —
// and say nothing beyond "up".

let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
});

describe("GET /api/health", () => {
  it("answers 200 { ok: true } with no session and nothing else", async () => {
    app = Fastify({ logger: false });
    await app.register(healthPlugin);
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});
