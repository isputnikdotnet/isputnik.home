import { describe, expect, it } from "vitest";
import fastify from "fastify";
import { securityTxtPlugin } from "../src/core/security-txt.js";

async function fetchSecurityTxt(path: string) {
  const app = fastify();
  await app.register(securityTxtPlugin);
  const response = await app.inject({ method: "GET", url: path });
  await app.close();
  return response;
}

describe("security.txt", () => {
  it("serves text/plain, not the SPA shell", async () => {
    const response = await fetchSecurityTxt("/.well-known/security.txt");
    expect(response.statusCode).toBe(200);
    // The whole point: an internet.nl scan reported the file as malformed because
    // the SPA fallback answered with index.html as text/html.
    expect(response.headers["content-type"]).toMatch(/^text\/plain/);
    expect(response.body).not.toContain("<!doctype html>");
  });

  it("is served from the legacy top-level path too", async () => {
    const response = await fetchSecurityTxt("/security.txt");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^text\/plain/);
  });

  it("carries the two fields RFC 9116 requires", async () => {
    const { body } = await fetchSecurityTxt("/.well-known/security.txt");
    expect(body).toMatch(/^Contact: https:\/\/github\.com\/.+/m);
    expect(body).toMatch(/^Expires: /m);
  });

  it("expires in the future but inside a year", async () => {
    const { body } = await fetchSecurityTxt("/.well-known/security.txt");
    const raw = /^Expires: (.+)$/m.exec(body)?.[1] ?? "";
    // Fractional seconds are legal but trip strict parsers, so they're stripped.
    expect(raw).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const expires = new Date(raw).getTime();
    expect(expires).toBeGreaterThan(Date.now());
    // Computed per request, so it can never go stale on a long-running install —
    // but it still has to stay under the one year the RFC asks for.
    expect(expires).toBeLessThan(Date.now() + 365 * 24 * 60 * 60 * 1000);
  });
});
