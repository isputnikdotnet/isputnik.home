import { describe, expect, it } from "vitest";
import { totpCode } from "./helpers/totp.js";
import {
  encryptSecret,
  decryptSecret,
  generateBackupCodes,
  hashBackupCode,
  normalizeBackupCode,
  generateTotpSecret,
  totpKeyUri,
  verifyTotp,
  isLegacyTotpSecret,
  totpSecretBytes,
  generateEmailCode,
  hashEmailCode,
  verifyEmailCode,
  maskEmail
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
    expect(verifyTotp(secret, totpCode(secret))).toBe(true);
  });

  it("ignores spaces in the entered code", () => {
    const secret = generateTotpSecret();
    const token = totpCode(secret);
    expect(verifyTotp(secret, `${token.slice(0, 3)} ${token.slice(3)}`)).toBe(true);
  });

  it("rejects a code generated from a different secret", () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(verifyTotp(a, totpCode(b))).toBe(false);
  });

  // RFC 4226 sets a 128-bit floor and otplib enforces it. Releases before 3.10.3
  // minted 80-bit secrets, so a secret is now the one thing a fresh enrollment
  // must get right — an under-length one can't be verified at all.
  it("mints 160-bit secrets", () => {
    const secret = generateTotpSecret();
    expect(totpSecretBytes(secret)).toBe(20);
    expect(isLegacyTotpSecret(secret)).toBe(false);
  });

  // A pre-3.10.3 secret has to be recognisable as such, because otherwise every
  // code it is shown looks merely "wrong" and the account has no way to learn
  // that re-enrolling is the fix. 16 base32 chars is exactly what v12 produced.
  it("flags a pre-3.10.3 secret as legacy rather than merely failing", () => {
    const legacy = "JBSWY3DPEHPK3PXP";
    expect(totpSecretBytes(legacy)).toBe(10);
    expect(isLegacyTotpSecret(legacy)).toBe(true);
    // Still a plain false, never a throw — callers treat it as a failed code.
    expect(verifyTotp(legacy, "123456")).toBe(false);
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

describe("Emailed one-time codes", () => {
  it("generates 6 digits, keeping leading zeros", () => {
    for (let i = 0; i < 200; i += 1) expect(generateEmailCode()).toMatch(/^\d{6}$/);
  });

  it("verifies the code it hashed", () => {
    const code = generateEmailCode();
    expect(verifyEmailCode(hashEmailCode(code), code)).toBe(true);
  });

  it("tolerates spaces or dashes the user typed", () => {
    expect(verifyEmailCode(hashEmailCode("012345"), "012 345")).toBe(true);
    expect(verifyEmailCode(hashEmailCode("012345"), "012-345")).toBe(true);
  });

  it("rejects a different code", () => {
    expect(verifyEmailCode(hashEmailCode("012345"), "543210")).toBe(false);
  });

  it("rejects input with no digits rather than matching an empty hash", () => {
    expect(verifyEmailCode(hashEmailCode("012345"), "ABCDE-FGHJK")).toBe(false);
    expect(verifyEmailCode(hashEmailCode("012345"), "")).toBe(false);
  });

  it("stores nothing replayable — the hash never contains the code", () => {
    const code = generateEmailCode();
    expect(hashEmailCode(code)).not.toContain(code);
    expect(hashEmailCode(code)).toHaveLength(64);
  });
});

describe("Email masking", () => {
  it("keeps the first and last character of the name and the whole domain", () => {
    expect(maskEmail("sergey@example.com")).toBe("s•••y@example.com");
  });

  it("handles very short names", () => {
    expect(maskEmail("jo@example.com")).toBe("j•••@example.com");
  });

  it("survives an address with an @ in the local part", () => {
    expect(maskEmail("a@b@example.com")).toBe("a•••b@example.com");
  });

  it("gives up safely on something that isn't an address", () => {
    expect(maskEmail("nonsense")).toBe("•••");
  });
});
