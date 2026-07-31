import { beforeEach, describe, expect, it } from "vitest";
import { authenticator } from "otplib";
import { db } from "../src/db.js";
import { generateTotpSecret, hashEmailCode, EMAIL_CODE_MAX_SENDS } from "../src/core/mfa.js";
import {
  getMfaStatus,
  beginMfaSetup,
  activateMfa,
  regenerateBackupCodes,
  consumeBackupCode,
  resetMfa,
  createMfaChallenge,
  resolveMfaChallenge,
  resolveEnrollChallenge,
  rotateEmailCode,
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
  const setup = beginMfaSetup(userId, "totp");
  if (setup.method !== "totp") throw new Error("expected a totp setup");
  const codes = activateMfa(userId, authenticator.generate(setup.secret));
  if (!codes) throw new Error("activation failed in test helper");
  return codes;
}

// Same, for the email method: the setup call hands back the code it wants mailed.
function enableEmail(userId: string): string[] {
  const setup = beginMfaSetup(userId, "email");
  if (setup.method !== "email") throw new Error("expected an email setup");
  const codes = activateMfa(userId, setup.code);
  if (!codes) throw new Error("activation failed in test helper");
  return codes;
}

describe("MFA enrollment", () => {
  it("stashes the secret encrypted and stays disabled until activated", () => {
    const setup = beginMfaSetup("u1", "totp");
    const row = db.prepare("SELECT mfa_secret, mfa_enabled FROM users WHERE id = 'u1'").get() as {
      mfa_secret: string;
      mfa_enabled: number;
    };
    expect(row.mfa_enabled).toBe(0);
    expect(row.mfa_secret).not.toBeNull();
    // ciphertext, not the base32 secret
    expect(row.mfa_secret).not.toContain(setup.method === "totp" ? setup.secret : "");
  });

  it("activates with a valid code and issues 10 backup codes", () => {
    const setup = beginMfaSetup("u1", "totp");
    if (setup.method !== "totp") throw new Error("expected a totp setup");
    const codes = activateMfa("u1", authenticator.generate(setup.secret));
    expect(codes).toHaveLength(10);
    expect(getMfaStatus("u1")).toEqual({ enabled: true, method: "totp", backupCodesRemaining: 10 });
  });

  it("rejects a wrong activation code and stays disabled", () => {
    beginMfaSetup("u1", "totp");
    const otherSecret = generateTotpSecret();
    expect(activateMfa("u1", authenticator.generate(otherSecret))).toBeNull();
    expect(getMfaStatus("u1").enabled).toBe(false);
  });

  it("resetMfa clears the flag, method, secret, and codes", () => {
    enableEmail("u1");
    resetMfa("u1");
    expect(getMfaStatus("u1")).toEqual({ enabled: false, method: "totp", backupCodesRemaining: 0 });
    const row = db.prepare("SELECT mfa_secret FROM users WHERE id = 'u1'").get() as { mfa_secret: string | null };
    expect(row.mfa_secret).toBeNull();
  });
});

describe("MFA enrollment by email", () => {
  it("keeps no secret and stores the emailed code only as a hash", () => {
    const setup = beginMfaSetup("u1", "email");
    if (setup.method !== "email") throw new Error("expected an email setup");
    expect(setup.code).toMatch(/^\d{6}$/);

    const user = db.prepare("SELECT mfa_method, mfa_secret, mfa_enabled FROM users WHERE id = 'u1'").get() as {
      mfa_method: string;
      mfa_secret: string | null;
      mfa_enabled: number;
    };
    expect(user).toMatchObject({ mfa_method: "email", mfa_secret: null, mfa_enabled: 0 });

    const challenge = resolveEnrollChallenge("u1");
    expect(challenge?.code_hash).toBe(hashEmailCode(setup.code));
    expect(challenge?.code_hash).not.toContain(setup.code);
  });

  it("activates with the emailed code and clears the enrollment challenge", () => {
    const codes = enableEmail("u1");
    expect(codes).toHaveLength(10);
    expect(getMfaStatus("u1")).toEqual({ enabled: true, method: "email", backupCodesRemaining: 10 });
    expect(resolveEnrollChallenge("u1")).toBeNull();
  });

  it("rejects a wrong code, counts the attempt, and stays disabled", () => {
    const setup = beginMfaSetup("u1", "email");
    if (setup.method !== "email") throw new Error("expected an email setup");
    const wrong = String((Number(setup.code) + 1) % 1_000_000).padStart(6, "0");
    expect(activateMfa("u1", wrong)).toBeNull();
    expect(getMfaStatus("u1").enabled).toBe(false);
    expect(resolveEnrollChallenge("u1")?.attempts).toBe(1);
  });

  it("switching to the app method drops the pending email enrollment", () => {
    beginMfaSetup("u1", "email");
    beginMfaSetup("u1", "totp");
    expect(resolveEnrollChallenge("u1")).toBeNull();
    expect(getMfaStatus("u1").method).toBe("totp");
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
    const { id } = createMfaChallenge("u1");
    expect(resolveMfaChallenge(id)?.user_id).toBe("u1");
  });

  it("destroys the challenge once the attempt cap is hit", () => {
    const { id } = createMfaChallenge("u1");
    let attempts = 0;
    for (let i = 0; i < MFA_MAX_ATTEMPTS; i += 1) attempts = failMfaChallenge(id);
    expect(attempts).toBe(MFA_MAX_ATTEMPTS);
    expect(resolveMfaChallenge(id)).toBeNull();
  });

  it("ignores an expired challenge", () => {
    const { id } = createMfaChallenge("u1");
    db.prepare("UPDATE mfa_challenges SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), id);
    expect(resolveMfaChallenge(id)).toBeNull();
  });

  it("supersedes any earlier challenge for the same user", () => {
    const first = createMfaChallenge("u1");
    const second = createMfaChallenge("u1");
    expect(resolveMfaChallenge(first.id)).toBeNull();
    expect(resolveMfaChallenge(second.id)?.user_id).toBe("u1");
  });

  it("carries no code for the app method", () => {
    enable("u1");
    const challenge = createMfaChallenge("u1");
    expect(challenge.code).toBeNull();
    expect(resolveMfaChallenge(challenge.id)?.code_hash).toBeNull();
  });

  it("a login challenge doesn't disturb a pending enrollment, or vice versa", () => {
    beginMfaSetup("u1", "email");
    const enrollCode = resolveEnrollChallenge("u1")?.code_hash;
    createMfaChallenge("u1", "login");
    expect(resolveEnrollChallenge("u1")?.code_hash).toBe(enrollCode);
  });
});

describe("MFA emailed sign-in codes", () => {
  beforeEach(() => {
    enableEmail("u1");
  });

  it("mints a fresh 6-digit code per challenge, stored hashed", () => {
    const first = createMfaChallenge("u1");
    const second = createMfaChallenge("u1");
    expect(first.code).toMatch(/^\d{6}$/);
    expect(resolveMfaChallenge(second.id)?.code_hash).toBe(hashEmailCode(second.code!));
    // The superseded challenge is gone, so the old code can't still be redeemed.
    expect(resolveMfaChallenge(first.id)).toBeNull();
  });

  it("gives email challenges a longer life than TOTP ones", () => {
    const { id } = createMfaChallenge("u1");
    const row = db.prepare("SELECT expires_at FROM mfa_challenges WHERE id = ?").get(id) as { expires_at: string };
    expect(Date.parse(row.expires_at) - Date.now()).toBeGreaterThan(6 * 60_000);
  });

  it("resend replaces the code and retires the previous one", () => {
    const { id, code } = createMfaChallenge("u1");
    // The initial send counts against the budget; clear the cooldown to resend.
    db.prepare("UPDATE mfa_challenges SET last_sent_at = NULL WHERE id = ?").run(id);
    const outcome = rotateEmailCode(id);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.code).not.toBe(code);
    expect(resolveMfaChallenge(id)?.code_hash).toBe(hashEmailCode(outcome.code));
  });

  it("refuses a resend inside the cooldown", () => {
    const { id } = createMfaChallenge("u1");
    expect(rotateEmailCode(id)).toEqual({ ok: false, reason: "cooldown" });
  });

  it("stops resending once the per-challenge budget runs out", () => {
    const { id } = createMfaChallenge("u1");
    for (let i = 1; i < EMAIL_CODE_MAX_SENDS; i += 1) {
      db.prepare("UPDATE mfa_challenges SET last_sent_at = NULL WHERE id = ?").run(id);
      expect(rotateEmailCode(id).ok).toBe(true);
    }
    db.prepare("UPDATE mfa_challenges SET last_sent_at = NULL WHERE id = ?").run(id);
    expect(rotateEmailCode(id)).toEqual({ ok: false, reason: "limit" });
  });

  it("a resend doesn't extend the challenge's expiry", () => {
    const { id } = createMfaChallenge("u1");
    const before = (db.prepare("SELECT expires_at FROM mfa_challenges WHERE id = ?").get(id) as { expires_at: string })
      .expires_at;
    db.prepare("UPDATE mfa_challenges SET last_sent_at = NULL WHERE id = ?").run(id);
    rotateEmailCode(id);
    const after = (db.prepare("SELECT expires_at FROM mfa_challenges WHERE id = ?").get(id) as { expires_at: string })
      .expires_at;
    expect(after).toBe(before);
  });
});
