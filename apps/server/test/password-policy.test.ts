import { afterEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import {
  DEFAULT_PASSWORD_POLICY,
  getPasswordPolicy,
  setPasswordPolicy,
  validatePassword
} from "../src/core/password-policy.js";
import { setupSchema, credentialsSchema } from "../src/core/shared.js";

afterEach(() => {
  db.prepare("DELETE FROM app_settings WHERE key = 'password_policy'").run();
});

describe("validatePassword", () => {
  it("enforces the minimum length", () => {
    expect(validatePassword("short", { minLength: 8, requireComplexity: false })).toMatch(/at least 8/);
    expect(validatePassword("longenough", { minLength: 8, requireComplexity: false })).toBeNull();
  });

  it("requires 3 of 4 character classes when complexity is on", () => {
    const policy = { minLength: 8, requireComplexity: true };
    expect(validatePassword("alllowercase", policy)).toMatch(/at least three/); // 1 class
    expect(validatePassword("lowerUPPER12", policy)).toBeNull(); // 3 classes
    expect(validatePassword("Pa55word!!", policy)).toBeNull(); // 4 classes
  });

  it("ignores complexity when it isn't required", () => {
    expect(validatePassword("alllowercase", { minLength: 8, requireComplexity: false })).toBeNull();
  });
});

describe("password policy storage", () => {
  it("defaults when unset and round-trips", () => {
    expect(getPasswordPolicy()).toEqual(DEFAULT_PASSWORD_POLICY);
    const custom = { minLength: 12, requireComplexity: true };
    setPasswordPolicy(custom, null);
    expect(getPasswordPolicy()).toEqual(custom);
  });
});

describe("schema integration", () => {
  it("setupSchema enforces the live policy; login does not", () => {
    setPasswordPolicy({ minLength: 12, requireComplexity: false }, null);
    expect(setupSchema.safeParse({ email: "a@b.com", password: "shortpass", displayName: "Test" }).success).toBe(false);
    expect(setupSchema.safeParse({ email: "a@b.com", password: "longenoughpassword", displayName: "Test" }).success).toBe(true);
    // Login accepts any non-empty password regardless of the policy.
    expect(credentialsSchema.safeParse({ email: "a@b.com", password: "x" }).success).toBe(true);
  });
});

// An address pasted from a message, or typed on a phone keyboard that adds a
// space after the tap, used to be refused at sign-in as though it were malformed.
// Trimming has to happen BEFORE the address is validated, not in the transform
// afterwards, and every accepted spelling has to land on one stored form — the
// email column is UNIQUE, and the lookup matches on exactly this value.
describe("email normalisation", () => {
  const parse = (email: string) => credentialsSchema.safeParse({ email, password: "x" });

  it("accepts an address padded with whitespace and stores it trimmed", () => {
    for (const padded of [" a@b.com ", "a@b.com ", " a@b.com", "\ta@b.com\n"]) {
      const result = parse(padded);
      expect(result.success, `expected ${JSON.stringify(padded)} to be accepted`).toBe(true);
      expect(result.data?.email).toBe("a@b.com");
    }
  });

  it("lower-cases, so padding and capitalisation reach the same stored address", () => {
    expect(parse("  A@B.COM  ").data?.email).toBe("a@b.com");
    expect(parse("A@B.COM").data?.email).toBe("a@b.com");
  });

  it("still rejects what is genuinely not an address", () => {
    // Trimming the ends must not be mistaken for tolerating space inside one.
    for (const bad of ["a b@c.com", "bad", "", "   ", "a@", "@b.com"]) {
      expect(parse(bad).success, `expected ${JSON.stringify(bad)} to be rejected`).toBe(false);
    }
  });
});
