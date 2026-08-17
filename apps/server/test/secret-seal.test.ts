// Operator secrets (SMTP password, AbuseIPDB key) live in app_settings, which is
// copied wholesale into every backup zip. sealSecret keeps them encrypted at rest
// so a leaked backup is inert; openSecret un-seals for use, passes legacy
// plaintext through unchanged (so old installs keep working and migrate on save),
// and fails safe on anything it can't decrypt rather than throwing on a hot path.
import { describe, expect, it } from "vitest";
import { sealSecret, openSecret } from "../src/core/mfa.js";

describe("sealSecret / openSecret", () => {
  it("round-trips a secret", () => {
    const sealed = sealSecret("smtp-p@ssw0rd");
    expect(sealed).not.toContain("smtp-p@ssw0rd"); // not plaintext at rest
    expect(sealed.startsWith("enc:v1:")).toBe(true);
    expect(openSecret(sealed)).toBe("smtp-p@ssw0rd");
  });

  it("seals empty as empty (no ciphertext for a missing secret)", () => {
    expect(sealSecret("")).toBe("");
    expect(openSecret("")).toBe("");
    expect(openSecret(null)).toBe("");
    expect(openSecret(undefined)).toBe("");
  });

  it("passes a legacy plaintext value through unchanged", () => {
    // A value stored before sealing existed has no prefix — it must still read.
    expect(openSecret("legacy-plaintext-key")).toBe("legacy-plaintext-key");
  });

  it("fails safe (empty), never throws, on a corrupt sealed value", () => {
    expect(openSecret("enc:v1:not-valid-base64-ciphertext!!")).toBe("");
  });

  it("produces a different ciphertext each time (random IV)", () => {
    expect(sealSecret("same")).not.toBe(sealSecret("same"));
  });
});
