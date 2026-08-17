// The __Host- prefix pins a cookie to this exact origin (Secure + Path=/ + no
// Domain) so a sibling subdomain can't overwrite it — cookie-tossing. It requires
// Secure, so a plain-http LAN install has to keep the bare name or the browser
// drops the cookie and nothing can authenticate. hostCookieName encodes that rule
// for the session, MFA-challenge and passkey-ceremony cookies (and mirrors CSRF).
import { describe, expect, it } from "vitest";
import { hostCookieName } from "../src/core/cookies.js";

describe("hostCookieName", () => {
  it("prefixes with __Host- on a secure deployment", () => {
    expect(hostCookieName("isputnik_sid", true)).toBe("__Host-isputnik_sid");
    expect(hostCookieName("isputnik_mfa", true)).toBe("__Host-isputnik_mfa");
  });

  it("keeps the bare name on a plain-http deployment (the prefix needs Secure)", () => {
    expect(hostCookieName("isputnik_sid", false)).toBe("isputnik_sid");
    expect(hostCookieName("isputnik_pk_login", false)).toBe("isputnik_pk_login");
  });
});
