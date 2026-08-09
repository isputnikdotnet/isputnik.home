import type { FastifyInstance } from "fastify";
import { db, logActivity, publicUser, type User } from "../db.js";
import { verifyDummyPassword, verifyPassword } from "../crypto.js";
import { clearSession, currentUserPayload, issueSession, revokeCurrentSession } from "../auth.js";
import { onboardingPending } from "./setup.js";
import { parseBody, credentialsSchema, getUserByEmail } from "./shared.js";
import { createMfaChallenge, sendMfaCodeEmail, setMfaChallengeCookie } from "./mfa-routes.js";
import { isMailConfigured } from "./mail.js";
import { maskEmail } from "./mfa.js";
import { isTrustedIp, isAccountLocked, recordLoginAttempt, maybeAutoBlockIp } from "./security.js";
import { alertAccountLocked, alertIpAutoBlocked, reviewSignInLocation } from "./security-alerts.js";

export async function authPlugin(app: FastifyInstance) {
  app.post("/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = parseBody(credentialsSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid login details", details: parsed.error });
    }

    const email = parsed.data.email;
    // A request from a trusted network is exempt from lockout and (below) MFA.
    const trusted = isTrustedIp(request.ip);

    if (!trusted && isAccountLocked(email)) {
      logActivity({
        event: "auth.login_locked",
        detail: `Sign-in refused for ${email}: account temporarily locked after repeated failures.`,
        ipAddress: request.ip
      });
      return reply.code(429).send({ error: "Too many failed attempts. Please try again in a few minutes." });
    }

    const user = getUserByEmail(email);
    // No account, or a deactivated one: still spend a password verification, so a
    // miss can't be told from a wrong password by how long the answer took.
    const ok =
      user && user.is_active
        ? await verifyPassword(parsed.data.password, user.password_hash)
        : await verifyDummyPassword(parsed.data.password);

    // A password success is only a completed sign-in when there's no second factor
    // to come. Recording it here for an MFA account would clear the failure tally
    // (accountFailureCount counts back to the last success), so a caller who knows
    // the password could reset the lockout between code guesses and never lock out.
    // The success is recorded when the second factor completes — see mfa-routes.
    const awaitingSecondFactor = ok && Boolean(user!.mfa_enabled) && !trusted;
    if (!awaitingSecondFactor) recordLoginAttempt(email, request.ip, ok);

    if (!ok) {
      logActivity({
        event: "auth.login_failed",
        detail: `A sign-in attempt for ${email} failed.`,
        ipAddress: request.ip
      });
      // Trusted networks are never auto-blocked or locked out.
      if (!trusted) {
        if (maybeAutoBlockIp(request.ip)) alertIpAutoBlocked(request.ip);
        if (isAccountLocked(email)) alertAccountLocked(email, request.ip);
      }
      return reply.code(401).send({ error: "Invalid email or password" });
    }

    const authed = user!; // ok === true implies the user exists and is active

    // With MFA on, password success only earns a short-lived challenge — unless the
    // request is from a trusted network, which skips the second factor.
    if (authed.mfa_enabled && !trusted) {
      const { id: challengeId, code } = createMfaChallenge(authed.id);
      setMfaChallengeCookie(reply, challengeId, authed.mfa_method);

      // An emailed code is sent without waiting on SMTP: the browser gets the code
      // prompt immediately, and a slow or dead mail server can't stall the sign-in.
      // The user is told whether we could even try — with mail down their backup
      // codes are the way in, and saying so beats waiting for a mail that won't come.
      const byEmail = authed.mfa_method === "email";
      const emailSent = byEmail && isMailConfigured();
      if (code && emailSent) {
        void sendMfaCodeEmail(authed.email, code, "login").catch(() => {
          logActivity({
            event: "auth.mfa_code_send_failed",
            targetType: "user",
            targetId: authed.id,
            detail: "Couldn't email a two-factor sign-in code.",
            ipAddress: request.ip
          });
        });
      }

      logActivity({
        event: "auth.mfa_required",
        actorUserId: authed.id,
        targetType: "user",
        targetId: authed.id,
        detail: "Password accepted; awaiting a two-factor code.",
        ipAddress: request.ip
      });
      return reply.send({
        mfaRequired: true,
        method: authed.mfa_method,
        ...(byEmail ? { emailSent, sentTo: maskEmail(authed.email) } : {})
      });
    }

    issueSession(reply, authed.id, request);
    reviewSignInLocation(authed, request);
    logActivity({
      event: "auth.login",
      actorUserId: authed.id,
      targetType: "user",
      targetId: authed.id,
      detail: authed.mfa_enabled && trusted ? "Signed in (two-factor skipped on a trusted network)." : "Signed in.",
      ipAddress: request.ip
    });
    return reply.send({ user: publicUser(authed) });
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
    return reply.send({ ok: true });
  });

  app.get("/api/auth/me", { preHandler: app.authenticate }, async (request) => ({
    user: currentUserPayload(request),
    // Ride along on the request the app already makes at startup rather than adding a
    // second one to every page load. Admins only: nobody else can act on any of it.
    onboardingPending: request.user!.role === "admin" && onboardingPending()
  }));
}
