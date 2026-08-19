import { z } from "zod";
import type { FastifyRequest } from "fastify";
import { db } from "../db.js";
import type { User } from "../db.js";
import { config } from "../config.js";
import { getPasswordPolicy, validatePassword } from "./password-policy.js";

// Trim trailing slashes without a backtracking-prone regex: the Origin header is
// attacker-controlled and /\/+$/ is quadratic on a long run of slashes.
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* "/" */) end -= 1;
  return value.slice(0, end);
}

// The origin to build user-facing links (invite/share URLs) from. Prefer the
// origin of the page the caller is actually using (sent by the browser on the
// fetch), so links match the real URL — a LAN address or whichever public domain
// they arrived through — instead of a single configured default. This is what
// makes links follow the domain in use when multiple domains point at the app.
// Falls back to config.appUrl when the header is missing or malformed.
export function requestOrigin(request: FastifyRequest): string {
  const origin = request.headers.origin;
  if (typeof origin === "string" && /^https?:\/\/.+/i.test(origin)) {
    return stripTrailingSlashes(origin);
  }
  return stripTrailingSlashes(config.appUrl);
}

// Trim BEFORE validating, not after. An address arrives padded more often than
// not — pasted from a message, or with the space a phone keyboard adds after a
// tap — and validating first meant "you@example.com " was refused outright as a
// malformed address, at sign-in of all places. Trailing whitespace is not what
// makes an address wrong. Both halves still normalise to the same stored form,
// which the UNIQUE COLLATE NOCASE email column is matched on.
const emailField = z.string().trim().pipe(z.email()).transform((value) => value.toLowerCase());

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
    // `message`, not `error`: zod 4 renamed that key on schema PARAMS, but an
    // issue object still reads `message` — passing `error` here silently replaces
    // the policy's explanation with a bare "Invalid input".
    if (error) ctx.addIssue({ code: "custom", message: error });
  });
}

export const setupSchema = z.object({
  email: emailField,
  password: passwordPolicyField(),
  displayName: z.string().trim().min(2).max(80)
});

// Zod 4 reports an absent required field as "Invalid input: expected string,
// received undefined". That sentence is what the person actually reads: the web
// client builds its message from `details.fieldErrors` and only falls back to the
// route's own friendlier wording if there is none (see apps/web/src/api.ts). Zod 3
// said "Required" there, so restore just that case and leave every other message —
// lengths, formats, enums — to zod's own phrasing.
z.config({
  customError: (issue) =>
    issue.code === "invalid_type" && issue.input === undefined ? "Required" : undefined
});

export function parseBody<T>(schema: z.ZodType<T>, body: unknown) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    // .flatten() is deprecated in zod 4 but still emits the { formErrors,
    // fieldErrors } shape the web client parses. Kept deliberately: switching to
    // z.treeifyError() would change that wire format and every consumer with it.
    return { error: parsed.error.flatten() };
  }

  return { data: parsed.data };
}

export function getUserByEmail(email: string) {
  return db.prepare("SELECT * FROM users WHERE email = ? AND deleted_at IS NULL").get(email) as User | undefined;
}
