import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword, verifyDummyPassword } from "../src/crypto.js";
import { csrfCookieName } from "../src/core/csrf.js";

describe("csrfCookieName", () => {
  it("uses the __Host- prefix only where the browser will accept it", () => {
    // The prefix requires Secure; naming it that over plain http would have the
    // browser drop the cookie and 403 every mutation on a LAN deployment.
    expect(csrfCookieName(true)).toBe("__Host-isputnik_csrf");
    expect(csrfCookieName(false)).toBe("isputnik_csrf");
  });
});

// The login route answers an unknown email by verifying against a dummy hash, so
// that a miss can't be distinguished from a wrong password by response time. The
// failure mode worth guarding is the dummy path returning *early* — so the check
// is one-sided and deliberately loose, to stay honest on a loaded CI machine.
async function timeOf(run: () => Promise<unknown>, rounds = 3): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < rounds; i += 1) {
    const started = performance.now();
    await run();
    samples.push(performance.now() - started);
  }
  return samples.sort((a, b) => a - b)[Math.floor(rounds / 2)];
}

describe("verifyDummyPassword", () => {
  it("always reports failure", async () => {
    expect(await verifyDummyPassword("anything")).toBe(false);
    expect(await verifyDummyPassword("")).toBe(false);
  });

  it("costs about as much as verifying a real password", async () => {
    const stored = await hashPassword("correct horse battery staple");
    // Warm up: the very first dummy call also mints the hash it compares against.
    await verifyDummyPassword("warm-up");

    const real = await timeOf(() => verifyPassword("wrong password", stored));
    const dummy = await timeOf(() => verifyDummyPassword("wrong password"));

    expect(dummy).toBeGreaterThan(real * 0.25);
  });
});
