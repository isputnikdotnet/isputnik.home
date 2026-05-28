import { z } from "zod";
import { db } from "../db.js";
import type { User } from "../db.js";

export const credentialsSchema = z.object({
  email: z.string().email().transform((value) => value.trim().toLowerCase()),
  password: z.string().min(8, "Password must be at least 8 characters").max(200)
});

export const setupSchema = credentialsSchema.extend({
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
