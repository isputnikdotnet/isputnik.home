import { z } from "zod";
import { db } from "../db.js";
import type { User } from "../db.js";
import { getPasswordPolicy, validatePassword } from "./password-policy.js";

const emailField = z.string().email().transform((value) => value.trim().toLowerCase());

// Login: accept any non-empty password — the stored hash decides, and an old
// password must keep working even if the policy was later strengthened.
export const credentialsSchema = z.object({
  email: emailField,
  password: z.string().min(1).max(200)
});

// A password being SET — validated against the configurable password policy.
export function passwordPolicyField() {
  return z.string().max(200).superRefine((value, ctx) => {
    const error = validatePassword(value, getPasswordPolicy());
    if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
  });
}

export const setupSchema = z.object({
  email: emailField,
  password: passwordPolicyField(),
  displayName: z.string().trim().min(2).max(80)
});

export function parseBody<T>(schema: z.ZodSchema<T>, body: unknown) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return { error: parsed.error.flatten() };
  }

  return { data: parsed.data };
}

export function getUserByEmail(email: string) {
  return db.prepare("SELECT * FROM users WHERE email = ? AND deleted_at IS NULL").get(email) as User | undefined;
}
