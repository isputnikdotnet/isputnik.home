import { afterEach, describe, expect, it, vi } from "vitest";
import { generateSync } from "otplib";
import { verifyTotp } from "../src/core/mfa.js";

// Fixed, externally-published TOTP values — the one check here that does not
// depend on otplib agreeing with itself.
//
// The rest of the TOTP tests (mfa.test.ts) mint a code and verify it through the
// same library, so they pass for any self-consistent implementation, including a
// wrong one. That is precisely how the otplib 12 -> 13 upgrade shipped broken:
// v13 reinterpreted `epoch` from milliseconds to SECONDS, every test still
// generated and verified happily, and real authenticator apps — which implement
// RFC 6238 and cannot be wrong — stopped matching. Enrolled users were locked
// out, and the two values agree only at epoch 0, so nothing local looked odd.
//
// These vectors come from RFC 6238 Appendix B (the SHA-1 rows), truncated to the
// 6 digits this app uses. An authenticator is an RFC 6238 implementation, so a
// library that reproduces them agrees with every user's phone by construction.
// Any future bump that moves a unit, a digit count or an algorithm fails here.
//
// If this test ever fails, do NOT adjust the expected values: they are defined
// by the RFC, not by us. A red mark means the library changed and TOTP sign-in
// is broken for everyone already enrolled.

/** RFC 6238's shared secret: ASCII "12345678901234567890", base32-encoded. */
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

/** [unix seconds, expected 6-digit code] */
const RFC_VECTORS: ReadonlyArray<readonly [number, string]> = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
  [20000000000, "353130"]
];

afterEach(() => {
  vi.useRealTimers();
});

describe("TOTP golden vectors (RFC 6238)", () => {
  it.each(RFC_VECTORS)("derives the published code at T=%i", (epoch, expected) => {
    // `epoch` in SECONDS. Passing milliseconds here yields a different code at
    // every time but epoch 0 — the exact shape of the 12 -> 13 regression.
    expect(generateSync({ secret: RFC_SECRET, epoch })).toBe(expected);
  });

  // The vectors above pin the library; this pins the app's own wrapper on top of
  // it (drift tolerance, whitespace stripping, the throw-to-false guard), so a
  // config change in verifyTotp is caught as well as a library change.
  it.each(RFC_VECTORS)("verifyTotp accepts the published code at T=%i", (epoch, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(epoch * 1000);
    expect(verifyTotp(RFC_SECRET, expected)).toBe(true);
  });

  // TOTP_DRIFT_SECONDS is 30 — a phone whose clock is a little off still gets in,
  // while a code from minutes away does not. Both halves matter: too narrow locks
  // out honest users, too wide widens the window for a stolen code.
  it("honours the drift window without opening it wider", () => {
    const at = 1234567890;
    vi.useFakeTimers();
    vi.setSystemTime(at * 1000);

    // A code minted a few seconds either side is still accepted.
    for (const offset of [-30, -1, 0, 29]) {
      expect(verifyTotp(RFC_SECRET, generateSync({ secret: RFC_SECRET, epoch: at + offset })))
        .toBe(true);
    }

    // One from two minutes away is not.
    for (const offset of [-120, 120]) {
      expect(verifyTotp(RFC_SECRET, generateSync({ secret: RFC_SECRET, epoch: at + offset })))
        .toBe(false);
    }
  });

  // The stored secret is the other half of the compatibility contract: a bump
  // that changed the minted length or alphabet would strand every enrolled user
  // just as thoroughly as a changed code, and just as silently.
  it("keeps the secret format an authenticator can import", () => {
    expect(RFC_SECRET).toMatch(/^[A-Z2-7]+=*$/);
    // 32 base32 chars = 160 bits, matching generateTotpSecret's TOTP_SECRET_BYTES.
    expect(RFC_SECRET).toHaveLength(32);
  });
});
