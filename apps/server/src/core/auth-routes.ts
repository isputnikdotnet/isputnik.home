import type { FastifyInstance } from "fastify";
import { db, logActivity, publicUser, type User } from "../db.js";
import { verifyDummyPassword, verifyPassword } from "../crypto.js";
import { clearSession, currentUserPayload, issueSession, revokeCurrentSession } from "../auth.js";
import { onboardingPending } from "./setup.js";
import { parseBody, credentialsSchema, getUserByEmail } from "./shared.js";
import { createMfaChallenge, sendMfaCodeEmail, setMfaChallengeCookie } from "./mfa-routes.js";
import { isMailConfigured } from "./mail.js";
import { maskEmail } from "./mfa.js";
import { isTrustedIp, isAccountLocked, recordLoginAttempt, maybeAutoBlockIp, mfaRequiredOutside } from "./security.js";
import { alertAccountLocked, alertIpAutoBlocked, reviewSignInLocation } from "./security-alerts.js";

// Why a sign-in failed, for the activity log only — the answer sent back to the
// browser stays deliberately vague, and this log is admin-only.
//
// Without it, a mistyped address and a wrong password read identically, while the
// failures pile up against an email the user list cannot show: the lockout is keyed
// on what was typed, and an account's Locked badge comes from the address the
// account actually has. One transposed letter can therefore look exactly like a
// password that refuses to work, through a reset and a lockout both.
function failureReason(email: string, user: User | undefined): string {
  if (user) return user.is_active ? "wrong password" : "the account is deactivated";
  const deleted = db.prepare("SELECT 1 FROM users WHERE email = ? AND deleted_at IS NOT NULL").get(email);
  return deleted ? "that account was deleted" : "there is no account with that address";
}

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

    // Two ways a second factor becomes due: the account enrolled one (and the
    // request isn't from a trusted network), or the outside-MFA policy demands
    // one of every sign-in that can't be placed inside a trusted network —
    // enrolled or not (the un-enrolled get an emailed code below).
    const forcedOutside = ok && mfaRequiredOutside(request.ip, request.headers);

    // A password success is only a completed sign-in when there's no second factor
    // to come. Recording it here for an MFA account would clear the failure tally
    // (accountFailureCount counts back to the last success), so a caller who knows
    // the password could reset the lockout between code guesses and never lock out.
    // The success is recorded when the second factor completes — see mfa-routes.
    const awaitingSecondFactor = (ok && Boolean(user!.mfa_enabled) && !trusted) || forcedOutside;
    if (!awaitingSecondFactor) recordLoginAttempt(email, request.ip, ok);

    if (!ok) {
      logActivity({
        event: "auth.login_failed",
        detail: `A sign-in attempt for ${email} failed — ${failureReason(email, user)}.`,
        ipAddress: request.ip
      });
      // Trusted networks are never auto-blocked or locked out.
      if (!trusted) {
        const blocked = maybeAutoBlockIp(request.ip);
        if (blocked) alertIpAutoBlocked(request.ip, blocked);
        if (isAccountLocked(email)) alertAccountLocked(email, request.ip, Boolean(user));
      }
      return reply.code(401).send({ error: "Invalid email or password" });
    }

    const authed = user!; // ok === true implies the user exists and is active

    // With MFA on, password success only earns a short-lived challenge — unless the
    // request is from a trusted network, which skips the second factor (except when
    // forcedOutside says the network can't be told — see mfaRequiredOutside).
    if (awaitingSecondFactor) {
      // An enrolled account uses its chosen method. The outside-MFA policy's
      // fallback for an un-enrolled one is a code emailed to the sign-in address —
      // and when the server can't send mail, the sign-in is refused rather than
      // waved through: the policy's whole promise is that a password alone is
      // never enough from outside. Nothing is recorded against the account or the
      // IP for a refusal — the password was right, and the tally must not move.
      const enrolled = Boolean(authed.mfa_enabled);
      if (!enrolled && !isMailConfigured()) {
        logActivity({
          event: "auth.login_refused_mfa",
          targetType: "user",
          targetId: authed.id,
          detail:
            `Sign-in refused for ${email}: the policy requires a second factor outside trusted networks, ` +
            "the account has none set up, and the server can't email codes.",
          ipAddress: request.ip
        });
        return reply.code(403).send({
          error:
            "Signing in from outside the home network requires a second factor, and this account doesn't have one set up. " +
            "Sign in from home to set up two-factor authentication, or ask your administrator."
        });
      }

      const method = enrolled ? authed.mfa_method : "email";
      const { id: challengeId, code } = createMfaChallenge(authed.id, "login", method);
      setMfaChallengeCookie(reply, challengeId, method);

      // An emailed code is sent without waiting on SMTP: the browser gets the code
      // prompt immediately, and a slow or dead mail server can't stall the sign-in.
      // The user is told whether we could even try — with mail down their backup
      // codes are the way in, and saying so beats waiting for a mail that won't come.
      const byEmail = method === "email";
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
        detail: enrolled
          ? "Password accepted; awaiting a two-factor code."
          : "Password accepted; a sign-in code was emailed (second factor required outside trusted networks).",
        ipAddress: request.ip
      });
      return reply.send({
        mfaRequired: true,
        method,
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
