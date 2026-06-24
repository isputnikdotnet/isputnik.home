import type { FastifyInstance } from "fastify";
import { db, logActivity, publicUser, type User } from "../db.js";
import { verifyPassword } from "../crypto.js";
import { clearSession, currentUserPayload, issueSession, revokeCurrentSession } from "../auth.js";
import { parseBody, credentialsSchema, getUserByEmail } from "./shared.js";
import { createMfaChallenge, setMfaChallengeCookie } from "./mfa-routes.js";
import { isTrustedIp, isAccountLocked, recordLoginAttempt, maybeAutoBlockIp } from "./security.js";
import { alertAccountLocked, alertIpAutoBlocked } from "./security-alerts.js";

export async function authPlugin(app: FastifyInstance) {
  app.post("/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = parseBody(credentialsSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid login details", details: parsed.error });
      return;
    }

    const email = parsed.data.email;
    // A request from a trusted network is exempt from lockout and (below) MFA.
    const trusted = isTrustedIp(request.ip);

    if (!trusted && isAccountLocked(email)) {
      logActivity({
        event: "auth.login_locked",
        detail: "Sign-in refused: account temporarily locked after repeated failures.",
        ipAddress: request.ip
      });
      reply.code(429).send({ error: "Too many failed attempts. Please try again in a few minutes." });
      return;
    }

    const user = getUserByEmail(email);
    const ok = Boolean(user && user.is_active && (await verifyPassword(parsed.data.password, user.password_hash)));
    recordLoginAttempt(email, request.ip, ok);

    if (!ok) {
      logActivity({
        event: "auth.login_failed",
        detail: "A sign-in attempt failed.",
        ipAddress: request.ip
      });
      // Trusted networks are never auto-blocked or locked out.
      if (!trusted) {
        if (maybeAutoBlockIp(request.ip)) alertIpAutoBlocked(request.ip);
        if (isAccountLocked(email)) alertAccountLocked(email, request.ip);
      }
      reply.code(401).send({ error: "Invalid email or password" });
      return;
    }

    const authed = user!; // ok === true implies the user exists and is active

    // With MFA on, password success only earns a short-lived challenge — unless the
    // request is from a trusted network, which skips the second factor.
    if (authed.mfa_enabled && !trusted) {
      const challengeId = createMfaChallenge(authed.id);
      setMfaChallengeCookie(reply, challengeId);
      logActivity({
        event: "auth.mfa_required",
        actorUserId: authed.id,
        targetType: "user",
        targetId: authed.id,
        detail: "Password accepted; awaiting a two-factor code.",
        ipAddress: request.ip
      });
      reply.send({ mfaRequired: true });
      return;
    }

    issueSession(reply, authed.id, request);
    logActivity({
      event: "auth.login",
      actorUserId: authed.id,
      targetType: "user",
      targetId: authed.id,
      detail: authed.mfa_enabled && trusted ? "Signed in (two-factor skipped on a trusted network)." : "Signed in.",
      ipAddress: request.ip
    });
    reply.send({ user: publicUser(authed) });
  });

  app.post("/api/auth/logout", { preHandler: app.authenticate }, async (request, reply) => {
    logActivity({
      event: "auth.logout",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: request.user!.id,
      detail: "Signed out.",
      ipAddress: request.ip
    });
    revokeCurrentSession(request);
    clearSession(reply);
    reply.send({ ok: true });
  });

  app.get("/api/auth/me", { preHandler: app.authenticate }, async (request) => ({
    user: currentUserPayload(request)
  }));
}
