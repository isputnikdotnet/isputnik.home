import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { db, hasUsers, logActivity, publicUser, type User } from "../db.js";
import { hashPassword } from "../crypto.js";
import { issueSession } from "../auth.js";
import { parseBody, setupSchema } from "./shared.js";
import { getDefaultTheme } from "./app-config.js";
import { noteSignInNetwork } from "./security.js";

// Whether the first admin has been offered the setup guide yet.
//
// One flag for the INSTALL, not per user: the guide walks through storage, mail and
// the default theme, all of which are install-wide. A second admin joining later has
// nothing to set up, and being shown a wizard for settings someone else already chose
// would be worse than showing nothing.
const ONBOARDING_KEY = "onboarding_completed_at";

export function onboardingPending(): boolean {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(ONBOARDING_KEY) as
    | { value: string }
    | undefined;
  return !row?.value;
}

/** Finishing and skipping both land here. Skipping is a real answer — an admin who
 *  wants to look around first should not be asked again on every sign-in — and the
 *  guide stays reachable at /welcome for whenever they do want it. */
export function completeOnboarding(userId: string): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_by, updated_at)
    VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(ONBOARDING_KEY, userId);
}

export async function setupPlugin(app: FastifyInstance) {
  app.get("/api/setup/status", async () => ({
    requiresSetup: !hasUsers(),
    defaultTheme: getDefaultTheme()
  }));

  // Deliberately NOT on /api/setup/status, which is public: whether an install has
  // been configured yet is not something to tell an unauthenticated caller.
  app.get("/api/setup/onboarding", { preHandler: app.requireAdmin }, async () => ({
    pending: onboardingPending()
  }));

  app.post("/api/setup/onboarding/complete", { preHandler: app.requireAdmin }, async (request, reply) => {
    completeOnboarding(request.user!.id);
    logActivity({
      event: "setup.onboarding_completed",
      actorUserId: request.user!.id,
      targetType: "setting",
      targetId: "onboarding",
      detail: "Finished or skipped the setup guide.",
      ipAddress: request.ip
    });
    return reply.send({ pending: false });
  });

  app.post("/api/setup/admin", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (hasUsers()) {
      return reply.code(409).send({ error: "Setup has already been completed" });
    }

    const parsed = parseBody(setupSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid setup details", details: parsed.error });
    }

    const userId = nanoid(16);
    const passwordHash = await hashPassword(parsed.data.password);
    const user = db.transaction(() => {
      db.prepare(`
        INSERT INTO users (id, email, password_hash, display_name, role, protected_from_delete, theme)
        VALUES (?, ?, ?, ?, 'admin', 1, ?)
      `).run(userId, parsed.data.email, passwordHash, parsed.data.displayName, getDefaultTheme());

      return db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as User;
    })();

    issueSession(reply, user.id, request);
    noteSignInNetwork(user.id, request.ip);
    logActivity({
      event: "account.setup",
      actorUserId: user.id,
      targetType: "user",
      targetId: user.id,
      detail: "Created the setup administrator account.",
      ipAddress: request.ip
    });
    return reply.code(201).send({ user: publicUser(user) });
  });
}
