import { db } from "../db.js";

// Admin-tunable password policy, stored as JSON in app_settings (like the
// brute-force thresholds). Enforced on every password-SETTING flow — setup, invite
// acceptance, profile change, and admin create/reset — but never on login, so an
// account whose password predates a stricter policy can still sign in.

export interface PasswordPolicy {
  minLength: number;
  requireComplexity: boolean;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 8,
  requireComplexity: false
};

const POLICY_KEY = "password_policy";

export function getPasswordPolicy(): PasswordPolicy {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(POLICY_KEY) as { value: string } | undefined;
  if (!row) return { ...DEFAULT_PASSWORD_POLICY };
  try {
    return { ...DEFAULT_PASSWORD_POLICY, ...(JSON.parse(row.value) as Partial<PasswordPolicy>) };
  } catch {
    return { ...DEFAULT_PASSWORD_POLICY };
  }
}

export function setPasswordPolicy(policy: PasswordPolicy, userId: string | null): void {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_by = excluded.updated_by,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(POLICY_KEY, JSON.stringify(policy), userId);
}

// Returns an error message when the password violates the policy, or null when OK.
export function validatePassword(password: string, policy: PasswordPolicy = getPasswordPolicy()): string | null {
  if (password.length < policy.minLength) {
    return `Password must be at least ${policy.minLength} characters.`;
  }
  if (policy.requireComplexity) {
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
    if (classes < 3) {
      return "Password must include at least three of: lowercase letters, uppercase letters, numbers, and symbols.";
    }
  }
  return null;
}
