import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { SPEED_TEST_DEFAULT_BYTES, SPEED_TEST_MAX_BYTES, speedTestBytes, speedTestPlugin } from "../src/core/speed-test.js";
import { bootApp } from "./helpers/boot.js";
import { makeUser, resetDb } from "./helpers/seed.js";

// The TV app's connection test: a signed-in device reads N random bytes and times it.

let app: FastifyInstance;
let signIn: (userId: string) => Promise<string>;

beforeEach(async () => {
  resetDb();
  ({ app, signIn } = await bootApp({ plugins: [speedTestPlugin] }));
});

describe("GET /api/speed-test", () => {
  it("is closed to anyone not signed in", async () => {
    const res = await app.inject({ method: "GET", url: "/api/speed-test?bytes=1000" });
    expect(res.statusCode).toBe(401);
  });

  it("sends exactly the bytes asked for, uncompressed and uncached", async () => {
    makeUser("tv");
    const cookie = await signIn("tv");
    const res = await app.inject({ method: "GET", url: "/api/speed-test?bytes=2500000", headers: { cookie, "accept-encoding": "br, gzip" } });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(2_500_000);
    expect(res.headers["content-length"]).toBe("2500000");
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("holds the size inside what one request may have", () => {
    expect(speedTestBytes(undefined)).toBe(SPEED_TEST_DEFAULT_BYTES);
    expect(speedTestBytes("abc")).toBe(SPEED_TEST_DEFAULT_BYTES);
    expect(speedTestBytes("0")).toBe(SPEED_TEST_DEFAULT_BYTES);
    expect(speedTestBytes("-5")).toBe(SPEED_TEST_DEFAULT_BYTES);
    expect(speedTestBytes("1e9")).toBe(SPEED_TEST_DEFAULT_BYTES);
    expect(speedTestBytes(String(10 * SPEED_TEST_MAX_BYTES))).toBe(SPEED_TEST_MAX_BYTES);
    expect(speedTestBytes("4096")).toBe(4096);
  });
});
