import { beforeEach, describe, expect, it } from "vitest";
import { authenticator } from "otplib";
import { db } from "../src/db.js";
import { generateTotpSecret } from "../src/core/mfa.js";
import {
  getMfaStatus,
  beginMfaSetup,
  activateMfa,
  regenerateBackupCodes,
  consumeBackupCode,
  resetMfa,
  createMfaChallenge,
  resolveMfaChallenge,
  failMfaChallenge,
  MFA_MAX_ATTEMPTS
} from "../src/core/mfa-routes.js";
import { resetDb, makeUser } from "./helpers/seed.js";

beforeEach(() => {
  resetDb();
  makeUser("u1");
});

// Enable MFA for a user and return their backup codes.
function enable(userId: string): string[] {
  const { secret } = beginMfaSetup(userId);
  const codes = activateMfa(userId, authenticator.generate(secret));
  if (!codes) throw new Error("activation failed in test helper");
  return codes;
}

describe("MFA enrollment", () => {
  it("stashes the secret encrypted and stays disabled until activated", () => {
    const { secret } = beginMfaSetup("u1");
    const row = db.prepare("SELECT mfa_secret, mfa_enabled FROM users WHERE id = 'u1'").get() as {
      mfa_secret: string;
      mfa_enabled: number;
    };
    expect(row.mfa_enabled).toBe(0);
    expect(row.mfa_secret).not.toBeNull();
    expect(row.mfa_secret).not.toContain(secret); // ciphertext, not the base32 secret
  });

  it("activates with a valid code and issues 10 backup codes", () => {
    const { secret } = beginMfaSetup("u1");
    const codes = activateMfa("u1", authenticator.generate(secret));
    expect(codes).toHaveLength(10);
    expect(getMfaStatus("u1")).toEqual({ enabled: true, backupCodesRemaining: 10 });
  });

  it("rejects a wrong activation code and stays disabled", () => {
    beginMfaSetup("u1");
    const otherSecret = generateTotpSecret();
    expect(activateMfa("u1", authenticator.generate(otherSecret))).toBeNull();
    expect(getMfaStatus("u1").enabled).toBe(false);
  });

  it("resetMfa clears the flag, secret, and codes", () => {
    enable("u1");
    resetMfa("u1");
    expect(getMfaStatus("u1")).toEqual({ enabled: false, backupCodesRemaining: 0 });
    const row = db.prepare("SELECT mfa_secret FROM users WHERE id = 'u1'").get() as { mfa_secret: string | null };
    expect(row.mfa_secret).toBeNull();
  });
});

describe("MFA backup codes", () => {
  it("consumes a code once and rejects reuse", () => {
    const codes = enable("u1");
    expect(consumeBackupCode("u1", codes[0])).toBe(true);
    expect(consumeBackupCode("u1", codes[0])).toBe(false);
    expect(getMfaStatus("u1").backupCodesRemaining).toBe(9);
  });

  it("rejects an unknown code", () => {
    enable("u1");
    expect(consumeBackupCode("u1", "ZZZZZ-ZZZZZ")).toBe(false);
  });

  it("regenerate replaces the whole set", () => {
    const first = enable("u1");
    const second = regenerateBackupCodes("u1");
    expect(second).toHaveLength(10);
    expect(consumeBackupCode("u1", first[0])).toBe(false);
    expect(consumeBackupCode("u1", second[0])).toBe(true);
  });
});

describe("MFA login challenge", () => {
  it("resolves a fresh challenge to its user", () => {
    const id = createMfaChallenge("u1");
    expect(resolveMfaChallenge(id)?.user_id).toBe("u1");
  });

  it("destroys the challenge once the attempt cap is hit", () => {
    const id = createMfaChallenge("u1");
    let attempts = 0;
    for (let i = 0; i < MFA_MAX_ATTEMPTS; i += 1) attempts = failMfaChallenge(id);
    expect(attempts).toBe(MFA_MAX_ATTEMPTS);
    expect(resolveMfaChallenge(id)).toBeNull();
  });

  it("ignores an expired challenge", () => {
    const id = createMfaChallenge("u1");
    db.prepare("UPDATE mfa_challenges SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), id);
    expect(resolveMfaChallenge(id)).toBeNull();
  });

  it("supersedes any earlier challenge for the same user", () => {
    const first = createMfaChallenge("u1");
    const second = createMfaChallenge("u1");
    expect(resolveMfaChallenge(first)).toBeNull();
    expect(resolveMfaChallenge(second)?.user_id).toBe("u1");
  });
});
