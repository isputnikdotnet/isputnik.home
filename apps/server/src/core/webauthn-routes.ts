import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { db, logActivity, publicUser, type User } from "../db.js";
import { config } from "../config.js";
import { hostCookieName } from "./cookies.js";
import { verifyPassword } from "../crypto.js";
import { issueSession } from "../auth.js";
import { parseBody } from "./shared.js";
import { alertAccountLocked, alertIpAutoBlocked, flagAbusiveRequest, reviewSignInLocation } from "./security-alerts.js";
import { isAccountLocked, isTrustedRequest, maybeAutoBlockIp, recordLoginAttempt } from "./security.js";
import {
  passkeysAvailable,
  buildRegistrationOptions,
  verifyRegistration,
  insertPasskey,
  buildAuthenticationOptions,
  verifyAssertion,
  listPasskeys,
  deletePasskey,
  findPasskeyByCredentialId,
  touchPasskey,
  counterLooksCloned,
  createWebauthnChallenge,
  resolveWebauthnChallenge,
  clearWebauthnChallenge,
  pruneWebauthnChallenges,
  type PasskeyRow
} from "./webauthn.js";

// Passkey enrollment and sign-in. Thin wrappers over webauthn.ts, adding the
// password gate, the challenge cookie, the lockout wiring and the activity log —
// the same shape as mfa-routes.ts over mfa.ts.
//
// The sign-in half reuses the existing brute-force machinery rather than growing a
// parallel one: a rejected assertion feeds the account lockout and the per-IP
// auto-block exactly as a wrong password does, and a credential id matching nothing
// at all is flagged as abuse the way an unknown OPDS token is.

// __Host-prefixed on secure deployments (see core/cookies.ts). Short-lived, so a
// plain rename is enough — set and read use these constants.
const REGISTER_COOKIE = hostCookieName("isputnik_pk_reg", config.cookieSecure);
const LOGIN_COOKIE = hostCookieName("isputnik_pk_login", config.cookieSecure);
const COOKIE_SECONDS = 5 * 60;

const passwordGateSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password").max(200)
});

const registerSchema = z.object({
  label: z.string().trim().max(60).optional(),
  // The ceremony payload is handed straight to simplewebauthn, which does the real
  // validation; zod only checks it is the right kind of object.
  response: z.looseObject({ id: z.string().min(1) })
});

const assertionSchema = z.object({
  response: z.looseObject({ id: z.string().min(1) })
});

function setCeremonyCookie(reply: FastifyReply, name: string, challengeId: string): void {
  reply.setCookie(name, challengeId, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_SECONDS
  });
}

function serializePasskey(row: PasskeyRow) {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    lastUsed: row.last_used_at,
    // Whether the credential syncs to a keychain. A device-bound key dies with the
    // device, and the UI says so where it still can be acted on.
    backedUp: Boolean(row.backed_up)
  };
}

/** 501 for every passkey route on an install that can't support them, so a stale
 *  client gets a straight answer instead of a confusing ceremony failure. */
function refuseIfUnavailable(reply: FastifyReply): boolean {
  if (passkeysAvailable()) return false;
  reply.code(501).send({
    error: "Passkeys need this server to be reached over HTTPS at a domain name. Ask your administrator."
  });
  return true;
}

export async function webauthnRoutes(app: FastifyInstance) {
  // ── Self-service management ────────────────────────────────────────────────

  app.get("/api/profile/passkeys", { preHandler: app.authenticate }, async (request) => ({
    available: passkeysAvailable(),
    passkeys: listPasskeys(request.user!.id).map(serializePasskey)
  }));

  // Step 1 of enrollment: prove the password, then get the options to hand to
  // navigator.credentials.create(). Password-gated for the same reason MFA setup is
  // — an unattended unlocked laptop shouldn't be able to add a permanent key.
  app.post("/api/profile/passkeys/options", { preHandler: app.authenticate }, async (request, reply) => {
    if (refuseIfUnavailable(reply)) return reply;
    const parsed = parseBody(passwordGateSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Enter your current password", details: parsed.error });
    }
    const user = request.user!;
    if (!(await verifyPassword(parsed.data.currentPassword, user.password_hash))) {
      return reply.code(403).send({ error: "Your current password is incorrect." });
    }

    const options = await buildRegistrationOptions(user);
    const challengeId = createWebauthnChallenge(options.challenge, "register", user.id);
    setCeremonyCookie(reply, REGISTER_COOKIE, challengeId);
    return reply.send({ options });
  });

  // Step 2: verify what the authenticator produced and store the public key.
  app.post("/api/profile/passkeys", { preHandler: app.authenticate }, async (request, reply) => {
    if (refuseIfUnavailable(reply)) return reply;
    const challengeId = request.cookies[REGISTER_COOKIE];
    const challenge = challengeId ? resolveWebauthnChallenge(challengeId, "register") : null;
    if (!challenge || challenge.user_id !== request.user!.id) {
      reply.clearCookie(REGISTER_COOKIE, { path: "/" });
      return reply.code(400).send({ error: "That took too long. Start again to add a passkey." });
    }

    const parsed = parseBody(registerSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid passkey response", details: parsed.error });
    }

    const verified = await verifyRegistration(
      parsed.data.response as unknown as RegistrationResponseJSON,
      challenge.challenge
    );
    clearWebauthnChallenge(challenge.id);
    reply.clearCookie(REGISTER_COOKIE, { path: "/" });
    if (!verified) {
      return reply.code(400).send({ error: "That passkey couldn't be verified. Try again." });
    }

    // The same credential can't be registered twice — excludeCredentials asks the
    // authenticator to prevent it, but the UNIQUE index is what enforces it.
    if (findPasskeyByCredentialId(verified.credentialId)) {
      return reply.code(409).send({ error: "That passkey is already registered on this account." });
    }

    const label = parsed.data.label?.length ? parsed.data.label : null;
    const id = insertPasskey(request.user!.id, label, verified);
    logActivity({
      event: "profile.passkey_added",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: request.user!.id,
      detail: `Added a passkey${label ? ` ("${label}")` : ""}.`,
      ipAddress: request.ip
    });
    return reply.code(201).send({ id });
  });

  // untrustedAllow: removing a lost/compromised passkey protects the account, the
  // same class as revoking a session or API token (which also opt out), so a
  // travelling user must not be blocked from it by the deletions-only policy.
  app.delete("/api/profile/passkeys/:id", { preHandler: app.authenticate, config: { untrustedAllow: true } }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!deletePasskey(request.user!.id, id)) {
      return reply.code(404).send({ error: "Passkey not found" });
    }
    logActivity({
      event: "profile.passkey_removed",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: request.user!.id,
      detail: "Removed a passkey.",
      ipAddress: request.ip
    });
    return reply.send({ ok: true });
  });

  // ── Sign-in ────────────────────────────────────────────────────────────────

  // Anonymous by design: the credentials are discoverable, so the browser picks the
  // account. The response is identical whoever is asking — it names no accounts and
  // reveals nothing about which exist.
  app.post(
    "/api/auth/passkey/options",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (_request, reply) => {
      if (refuseIfUnavailable(reply)) return reply;
      pruneWebauthnChallenges();
      const options = await buildAuthenticationOptions();
      const challengeId = createWebauthnChallenge(options.challenge, "login", null);
      setCeremonyCookie(reply, LOGIN_COOKIE, challengeId);
      return reply.send({ options });
    }
  );

  app.post(
    "/api/auth/passkey/verify",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (refuseIfUnavailable(reply)) return reply;
      const challengeId = request.cookies[LOGIN_COOKIE];
      const challenge = challengeId ? resolveWebauthnChallenge(challengeId, "login") : null;
      if (!challenge) {
        reply.clearCookie(LOGIN_COOKIE, { path: "/" });
        return reply.code(401).send({ error: "That sign-in expired. Try again." });
      }

      const parsed = parseBody(assertionSchema, request.body);
      if (parsed.error) {
        return reply.code(400).send({ error: "Invalid passkey response", details: parsed.error });
      }
      const assertion = parsed.data.response as unknown as AuthenticationResponseJSON;

      const passkey = findPasskeyByCredentialId(assertion.id);
      if (!passkey) {
        // A credential id matching nothing at all is a guess, not a stale device —
        // the same distinction the OPDS token path draws. Revoked passkeys are
        // deleted rather than tombstoned, so a just-removed key lands here too;
        // that costs one flag against an IP that genuinely did just try an unknown
        // credential, which is the conservative side to err on.
        flagAbusiveRequest(request, "token");
        clearWebauthnChallenge(challenge.id);
        reply.clearCookie(LOGIN_COOKIE, { path: "/" });
        return reply.code(401).send({ error: "That passkey isn't registered here." });
      }

      const user = db
        .prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL AND is_active = 1")
        .get(passkey.user_id) as User | undefined;
      if (!user) {
        clearWebauthnChallenge(challenge.id);
        reply.clearCookie(LOGIN_COOKIE, { path: "/" });
        return reply.code(401).send({ error: "That account is no longer active." });
      }

      const trusted = isTrustedRequest(request);
      if (!trusted && isAccountLocked(user.email)) {
        clearWebauthnChallenge(challenge.id);
        reply.clearCookie(LOGIN_COOKIE, { path: "/" });
        logActivity({
          event: "auth.login_locked",
          detail: `Passkey sign-in refused for ${user.email}: account temporarily locked after repeated failures.`,
          ipAddress: request.ip
        });
        return reply.code(429).send({ error: "Too many failed attempts. Please try again in a few minutes." });
      }

      const verified = await verifyAssertion(assertion, challenge.challenge, passkey);
      clearWebauthnChallenge(challenge.id);
      reply.clearCookie(LOGIN_COOKIE, { path: "/" });

      // A verified assertion WITHOUT user verification is a bare presence tap: one
      // factor, not the two this route's skip-the-code promise rests on. Refused
      // rather than quietly downgraded to a password-equivalent sign-in.
      if (!verified || !verified.userVerified) {
        recordLoginAttempt(user.email, request.ip, false);
        logActivity({
          event: "auth.passkey_failed",
          targetType: "user",
          targetId: user.id,
          detail: verified
            ? "A passkey sign-in was refused: the device didn't verify the person using it."
            : "A passkey sign-in failed verification.",
          ipAddress: request.ip
        });
        if (!trusted) {
          const blocked = maybeAutoBlockIp(request.ip);
          if (blocked) alertIpAutoBlocked(request.ip, blocked);
          if (isAccountLocked(user.email)) alertAccountLocked(user.email, request.ip);
        }
        return reply.code(401).send({
          error: verified
            ? "Your device didn't confirm it was you. Use a fingerprint, face or PIN and try again."
            : "That passkey couldn't be verified."
        });
      }

      if (counterLooksCloned(passkey.counter, verified.newCounter)) {
        // Not fatal — but it is the one thing the counter is for, so it goes in the
        // log where an admin reviewing an account can find it.
        logActivity({
          event: "auth.passkey_counter_regressed",
          targetType: "user",
          targetId: user.id,
          detail: "A passkey reported a use counter that didn't advance — the credential may have been copied.",
          ipAddress: request.ip
        });
      }

      touchPasskey(passkey.credential_id, verified.newCounter, request.ip);
      // A completed sign-in, so the failure tally resets exactly as a password
      // success resets it.
      recordLoginAttempt(user.email, request.ip, true);
      issueSession(reply, user.id, request);
      reviewSignInLocation(user, request);
      logActivity({
        event: "auth.passkey_login",
        actorUserId: user.id,
        targetType: "user",
        targetId: user.id,
        // Worth spelling out in the log: this account may have two-factor on, and
        // the absence of a code step here is by design, not a bypass.
        detail: user.mfa_enabled
          ? "Signed in with a passkey (two-factor satisfied by the device's own check)."
          : "Signed in with a passkey.",
        ipAddress: request.ip
      });
      return reply.send({ user: publicUser(user) });
    }
  );
}
