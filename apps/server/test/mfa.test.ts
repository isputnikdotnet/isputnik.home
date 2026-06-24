import { describe, expect, it } from "vitest";
import { authenticator } from "otplib";
import {
  encryptSecret,
  decryptSecret,
  generateBackupCodes,
  hashBackupCode,
  normalizeBackupCode,
  generateTotpSecret,
  totpKeyUri,
  verifyTotp
} from "../src/core/mfa.js";

describe("MFA secret encryption", () => {
  it("round-trips a TOTP secret", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("rejects a tampered ciphertext (GCM auth tag)", () => {
    const raw = Buffer.from(encryptSecret("secret"), "base64");
    raw[raw.length - 1] ^= 0xff; // flip a ciphertext byte
    expect(() => decryptSecret(raw.toString("base64"))).toThrow();
  });
});

describe("MFA backup codes", () => {
  it("generates the requested count with matching hashes", () => {
    const { plain, hashes } = generateBackupCodes(8);
    expect(plain).toHaveLength(8);
    expect(hashes).toHaveLength(8);
    plain.forEach((code, i) => expect(hashBackupCode(code)).toBe(hashes[i]));
  });

  it("verifies regardless of dashes or case", () => {
    const { plain, hashes } = generateBackupCodes(1);
    const messy = plain[0].toLowerCase().replace("-", "");
    expect(hashBackupCode(messy)).toBe(hashes[0]);
  });

  it("normalizes to the canonical form", () => {
    expect(normalizeBackupCode("abcde-fghjk")).toBe("ABCDEFGHJK");
  });
});

describe("TOTP", () => {
  it("verifies a freshly generated code", () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, authenticator.generate(secret))).toBe(true);
  });

  it("ignores spaces in the entered code", () => {
    const secret = generateTotpSecret();
    const token = authenticator.generate(secret);
    expect(verifyTotp(secret, `${token.slice(0, 3)} ${token.slice(3)}`)).toBe(true);
  });

  it("rejects a code generated from a different secret", () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(verifyTotp(a, authenticator.generate(b))).toBe(false);
  });

  it("rejects malformed input without throwing", () => {
    expect(verifyTotp(generateTotpSecret(), "not-a-code")).toBe(false);
  });

  it("builds an otpauth URI naming the issuer and account", () => {
    const uri = totpKeyUri("JBSWY3DPEHPK3PXP", "user@test.local");
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain("isputnik.home");
    expect(uri).toContain("user%40test.local");
  });
});
