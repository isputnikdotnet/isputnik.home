import { nanoid } from "nanoid";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON
} from "@simplewebauthn/server";
import { config } from "../config.js";
import { db, nowIso, type User } from "../db.js";

// Passkeys (WebAuthn). A passkey is a keypair whose private half stays in the
// user's device or synced keychain: signing in means the browser signs a
// server-issued challenge after a local biometric/PIN gesture. Two properties earn
// it its place next to passwords and TOTP:
//
//   * It is phishing-resistant. The credential is bound to the origin, so a
//     lookalike page cannot obtain a signature no matter how convincing it is.
//   * The gesture proves TWO factors at once — possession of the key plus the
//     biometric that released it — which is why a verified passkey sign-in skips
//     the second-factor prompt instead of asking for a code on top of a face scan.
//
// It is strictly ADDITIVE. WebAuthn needs a secure context and a registrable
// domain, so a plain-http LAN install cannot use it at all; password + TOTP stays
// the universal path and the way back in when every device is lost.
//
// Service functions live here and are unit-tested directly; the routes in
// webauthn-routes.ts are thin wrappers adding password-gating, cookies and
// logging — the same split as mfa.ts / mfa-routes.ts.

const RP_NAME = "iSputnik";

// How long a ceremony may sit unfinished. The browser's own timeout is 60s; the
// row gets more slack so a slow fingerprint retry doesn't fail on our side first.
const CHALLENGE_MINUTES = 5;

export type WebauthnPurpose = "login" | "register";

export interface PasskeyRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  backed_up: number;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  last_ip: string | null;
}

export interface WebauthnChallengeRow {
  id: string;
  user_id: string | null;
  purpose: WebauthnPurpose;
  challenge: string;
}

// ── Relying party ────────────────────────────────────────────────────────────
// APP_URL is the operator's statement of how the app is reached, and it's the only
// thing the process knows about its own address (TLS terminates at a proxy). Both
// the RP ID and the expected origin come from it, so an install that sets APP_URL
// wrongly gets a clean "origin mismatch" rather than a silent security hole.

function appUrl(): URL | null {
  try {
    return new URL(config.appUrl);
  } catch {
    return null;
  }
}

/** The Relying Party ID: the bare hostname, which is what a passkey is bound to.
 *  A credential registered here works on this hostname and nowhere else. */
export function rpId(): string {
  return appUrl()?.hostname ?? "localhost";
}

/** The exact origin an assertion must have come from — scheme, host AND port. */
export function rpOrigin(): string {
  return appUrl()?.origin ?? "http://localhost";
}

export function rpName(): string {
  return RP_NAME;
}

// "localhost" specifically — NOT 127.0.0.1. Browsers treat both as secure contexts,
// but only the name is a registrable domain, and the RP ID has to be one: asking for
// rp.id "127.0.0.1" fails with "The relying party ID is not a registrable domain
// suffix of, nor equal to, the current domain" no matter where you browse from.
// So a dev server reached at the default http://127.0.0.1:5173 genuinely cannot do
// passkeys, and saying otherwise would offer a button that always throws. Set
// APP_URL=http://localhost:5173 (and browse there) to exercise them locally.
const LOOPBACK_HOSTS = new Set(["localhost"]);

/** Whether this install can offer passkeys at all.
 *
 *  Two hard browser rules decide it, and neither is ours to bend: WebAuthn exists
 *  only in a secure context, and the RP ID must be a registrable domain — an IP
 *  address cannot be one, so even https://192.168.1.50 is out. A plain-http LAN
 *  install therefore gets no passkeys, and the UI says so rather than offering a
 *  button that could only fail. */
export function passkeysAvailable(): boolean {
  const url = appUrl();
  if (!url) return false;
  const host = url.hostname;
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (url.protocol !== "https:") return false;
  // A bare IPv4/IPv6 literal is not a registrable domain, so it can't be an RP ID.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  if (host.startsWith("[")) return false;
  return host.includes(".");
}

// ── Challenges ───────────────────────────────────────────────────────────────

export function createWebauthnChallenge(challenge: string, purpose: WebauthnPurpose, userId: string | null): string {
  const id = nanoid(24);
  const expiresAt = new Date(Date.now() + CHALLENGE_MINUTES * 60_000).toISOString();
  // One pending ceremony per user per purpose — a restarted registration supersedes
  // the abandoned one instead of leaving it to expire on its own.
  if (userId) {
    db.prepare("DELETE FROM webauthn_challenges WHERE user_id = ? AND purpose = ?").run(userId, purpose);
  }
  db.prepare(
    "INSERT INTO webauthn_challenges (id, user_id, purpose, challenge, expires_at) VALUES (?, ?, ?, ?, ?)"
  ).run(id, userId, purpose, challenge, expiresAt);
  return id;
}

export function resolveWebauthnChallenge(id: string, purpose: WebauthnPurpose): WebauthnChallengeRow | null {
  const row = db
    .prepare(
      `SELECT id, user_id, purpose, challenge FROM webauthn_challenges
       WHERE id = ? AND purpose = ? AND datetime(expires_at) > datetime('now')`
    )
    .get(id, purpose) as WebauthnChallengeRow | undefined;
  return row ?? null;
}

export function clearWebauthnChallenge(id: string): void {
  db.prepare("DELETE FROM webauthn_challenges WHERE id = ?").run(id);
}

/** Drop challenges nobody came back for. Called opportunistically when a new one
 *  is opened, so the table can't grow without bound on a public sign-in route. */
export function pruneWebauthnChallenges(): void {
  db.prepare("DELETE FROM webauthn_challenges WHERE datetime(expires_at) <= datetime('now')").run();
}

// ── Stored credentials ───────────────────────────────────────────────────────

export function listPasskeys(userId: string): PasskeyRow[] {
  return db
    .prepare("SELECT * FROM webauthn_credentials WHERE user_id = ? ORDER BY datetime(created_at) DESC")
    .all(userId) as PasskeyRow[];
}

export function countPasskeys(userId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?").get(userId) as { n: number };
  return row.n;
}

export function findPasskeyByCredentialId(credentialId: string): PasskeyRow | null {
  const row = db.prepare("SELECT * FROM webauthn_credentials WHERE credential_id = ?").get(credentialId) as
    | PasskeyRow
    | undefined;
  return row ?? null;
}

export function deletePasskey(userId: string, id: string): boolean {
  const result = db.prepare("DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?").run(id, userId);
  return result.changes > 0;
}

/** Remove every passkey on an account. Self-service teardown, and the admin rescue
 *  for a member who lost all their devices — they sign in with password + TOTP and
 *  enrol again. Returns how many were cleared. */
export function clearPasskeys(userId: string): number {
  return db.prepare("DELETE FROM webauthn_credentials WHERE user_id = ?").run(userId).changes;
}

export function parseTransports(stored: string | null): AuthenticatorTransportFuture[] | undefined {
  if (!stored) return undefined;
  try {
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed) ? (parsed as AuthenticatorTransportFuture[]) : undefined;
  } catch {
    return undefined;
  }
}

/** Record a successful assertion: bump the use counter and note when and from where.
 *
 *  The counter is the authenticator's own tally, and a value at or below the stored
 *  one can mean a cloned key. It is only ever a signal, never proof: synced passkeys
 *  (iCloud Keychain, Google Password Manager) report 0 forever by design, so a
 *  never-incrementing counter is the normal case for exactly the credentials most
 *  people will use. We therefore store the highest seen and let the caller decide;
 *  see counterLooksCloned below. */
export function touchPasskey(credentialId: string, newCounter: number, ip: string | null): void {
  db.prepare(
    `UPDATE webauthn_credentials
     SET counter = MAX(counter, ?), last_used_at = ?, last_ip = ?
     WHERE credential_id = ?`
  ).run(newCounter, nowIso(), ip, credentialId);
}

/** True when a counter went BACKWARDS from a non-zero value — the one shape that
 *  actually suggests a duplicated authenticator. A stored 0 (or a reported 0) means
 *  the authenticator doesn't count, which is not evidence of anything. */
export function counterLooksCloned(stored: number, reported: number): boolean {
  if (stored === 0 || reported === 0) return false;
  return reported <= stored;
}

// ── Registration ceremony ────────────────────────────────────────────────────

export async function buildRegistrationOptions(user: User): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const existing = listPasskeys(user.id);
  return generateRegistrationOptions({
    rpName: rpName(),
    rpID: rpId(),
    // The account's own id doubles as the WebAuthn user handle. It is an opaque
    // nanoid rather than the email, so the value stored in the user's keychain
    // carries no personal information — and it means no extra column on users.
    userID: new TextEncoder().encode(user.id),
    userName: user.email,
    userDisplayName: user.display_name,
    // No attestation: we don't care which brand of authenticator this is, and
    // asking for it would collect identifying data for nothing.
    attestationType: "none",
    // Already-registered keys are excluded so the authenticator says "you already
    // have one of these" instead of silently creating a duplicate.
    excludeCredentials: existing.map((row) => ({
      id: row.credential_id,
      transports: parseTransports(row.transports)
    })),
    authenticatorSelection: {
      // Discoverable, so signing in is one button with no email typed first.
      residentKey: "required",
      requireResidentKey: true,
      // The biometric/PIN gesture is the whole point: it is what makes this
      // multi-factor and lets a passkey sign-in skip the code prompt.
      userVerification: "required"
    }
  });
}

export interface VerifiedRegistration {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string | null;
  backedUp: boolean;
}

/** Verify an attestation against its challenge. Returns null when the ceremony
 *  doesn't check out or the authenticator didn't actually verify the user. */
export async function verifyRegistration(
  response: RegistrationResponseJSON,
  expectedChallenge: string
): Promise<VerifiedRegistration | null> {
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rpOrigin(),
      expectedRPID: rpId(),
      requireUserVerification: true
    });
  } catch {
    // The library throws on a malformed or mismatched response; that is a failed
    // ceremony like any other, not a server error.
    return null;
  }

  if (!verification.verified || !verification.registrationInfo) return null;
  const { credential, credentialBackedUp, userVerified } = verification.registrationInfo;
  if (!userVerified) return null;

  return {
    credentialId: credential.id,
    publicKey: isoBase64URL.fromBuffer(credential.publicKey),
    counter: credential.counter,
    transports: response.response.transports ? JSON.stringify(response.response.transports) : null,
    backedUp: credentialBackedUp
  };
}

export function insertPasskey(userId: string, label: string | null, verified: VerifiedRegistration): string {
  const id = nanoid(16);
  db.prepare(
    `INSERT INTO webauthn_credentials (id, user_id, credential_id, public_key, counter, transports, backed_up, label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    userId,
    verified.credentialId,
    verified.publicKey,
    verified.counter,
    verified.transports,
    verified.backedUp ? 1 : 0,
    label
  );
  return id;
}

// ── Authentication ceremony ──────────────────────────────────────────────────

export async function buildAuthenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: rpId(),
    // Deliberately empty: the credentials are discoverable, so the browser offers
    // the accounts it holds for this origin. Naming them here would also tell an
    // anonymous caller which accounts exist.
    allowCredentials: [],
    userVerification: "required"
  });
}

export interface VerifiedAssertion {
  credentialId: string;
  newCounter: number;
  userVerified: boolean;
}

/** Verify an assertion against a stored credential and its challenge. Returns null
 *  when the signature doesn't check out. A response that verifies but WITHOUT user
 *  verification comes back with userVerified false for the caller to refuse — it is
 *  a bare presence tap, one factor, not what this route promises. */
export async function verifyAssertion(
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  passkey: PasskeyRow
): Promise<VerifiedAssertion | null> {
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rpOrigin(),
      expectedRPID: rpId(),
      credential: {
        id: passkey.credential_id,
        publicKey: isoBase64URL.toBuffer(passkey.public_key),
        counter: passkey.counter,
        transports: parseTransports(passkey.transports)
      },
      requireUserVerification: true
    });
  } catch {
    return null;
  }

  if (!verification.verified) return null;
  const { credentialID, newCounter, userVerified } = verification.authenticationInfo;
  return { credentialId: credentialID, newCounter, userVerified };
}
