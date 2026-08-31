import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { generateSecret, generateURI, verifySync } from "otplib";
import QRCode from "qrcode";
import { config } from "../config.js";
import { sha256 } from "../crypto.js";

// Two-factor (TOTP) secret handling. Unlike passwords and session/invite tokens —
// which are one-way hashed — the TOTP shared secret must be recoverable to verify
// the rolling 6-digit code, so it's *encrypted* at rest with a server key.
//
// Key source, in order:
//   1. MFA_ENCRYPTION_KEY env (any string; sha256-derived to 32 bytes). Set this in
//      production and keep it stable: changing it makes every stored secret
//      undecryptable and forces re-enrolment — the same caveat applies when a DB
//      backup is restored onto a host that doesn't carry the same key.
//   2. A random key persisted beside the database (mfa.key, 0600) so a single-host
//      install works out of the box and survives restarts without any configuration.
let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  const fromEnv = process.env.MFA_ENCRYPTION_KEY;
  if (fromEnv && fromEnv.length > 0) {
    return crypto.createHash("sha256").update(fromEnv).digest();
  }

  const keyPath = path.join(path.dirname(config.dbPath), "mfa.key");
  try {
    const existing = fs.readFileSync(keyPath, "utf8").trim();
    if (existing.length === 64) return Buffer.from(existing, "hex");
  } catch {
    // Not created yet — fall through and mint one below.
  }

  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(keyPath, key.toString("hex"), { mode: 0o600 });
  } catch {
    // An unwritable data dir still yields a working (ephemeral) key for this run;
    // secrets won't survive a restart, but that only happens on a broken mount.
  }
  return key;
}

function key(): Buffer {
  return (cachedKey ??= loadKey());
}

// AES-256-GCM. Stored form: base64( iv(12) || authTag(16) || ciphertext ).
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptSecret(stored: string): string {
  const raw = Buffer.from(stored, "base64");
  // A shorter buffer can't hold the fixed iv+tag prefix, so the subarrays below
  // would silently yield a truncated auth tag. GCM accepts one (weakly) and Node
  // warns (DEP0182) on its way to making it an error — reject it as the corruption
  // it is instead. Callers already treat any throw here as "unreadable".
  if (raw.length < 28) throw new Error("malformed sealed value");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

// At-rest wrappers for operator secrets kept in app_settings (SMTP password,
// AbuseIPDB key). Those sit in the SQLite DB, which is copied wholesale into every
// backup zip — so a backup landing on a lax share used to leak working
// credentials. Sealing them means the DB alone is inert, the same property the
// hashed tokens and encrypted TOTP secrets already give it; mfa.key stays out of
// backups, so restoring on a new host needs the secrets re-entered (documented).
//
// The version prefix tells a sealed value from a legacy plaintext one, so old
// installs keep working and migrate on the next save. open fails SAFE: an
// undecryptable value (missing/rotated key, corruption) reads as empty rather
// than throwing — getSecurityPolicy runs on hot request paths, and a throw there
// would take the app down over an unreadable optional secret.
const SEALED_PREFIX = "enc:v1:";

export function sealSecret(plain: string): string {
  return plain ? SEALED_PREFIX + encryptSecret(plain) : "";
}

// True when a stored value is already sealed. Used by the "blank field = keep the
// stored secret" save paths: they preserve the RAW stored column and pass it back
// through, so an already-sealed value isn't re-sealed (and a transiently
// unreadable key can't be silently wiped by re-sealing openSecret's empty result).
export function isSealed(stored: string | null | undefined): boolean {
  return typeof stored === "string" && stored.startsWith(SEALED_PREFIX);
}

// Seal a value unless it is already sealed (the keep-path passes ciphertext
// through verbatim); a legacy plaintext value is sealed, migrating it.
export function ensureSealed(value: string): string {
  return isSealed(value) ? value : sealSecret(value);
}

export function openSecret(stored: string | null | undefined): string {
  if (!stored) return "";
  if (!stored.startsWith(SEALED_PREFIX)) return stored; // legacy plaintext, pre-sealing
  try {
    return decryptSecret(stored.slice(SEALED_PREFIX.length));
  } catch {
    return "";
  }
}

// Backup codes rescue an account when the authenticator is lost. Shown once on
// generation, stored only as sha256 hashes, and consumed single-use. Drawn from an
// unambiguous alphabet (no 0/O/1/I/L) and grouped XXXXX-XXXXX for readability.
const BACKUP_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

// Strip formatting so a code verifies whether the user types the dash or not and in
// any case — the canonical form (what we hash) is the bare uppercased characters.
export function normalizeBackupCode(code: string): string {
  return code.replace(/[^0-9a-z]/gi, "").toUpperCase();
}

export function hashBackupCode(code: string): string {
  return sha256(normalizeBackupCode(code));
}

export function generateBackupCodes(count = 10): { plain: string[]; hashes: string[] } {
  const plain: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let code = "";
    for (let c = 0; c < 10; c += 1) {
      code += BACKUP_ALPHABET[crypto.randomInt(BACKUP_ALPHABET.length)];
    }
    plain.push(`${code.slice(0, 5)}-${code.slice(5)}`);
  }
  return { plain, hashes: plain.map(hashBackupCode) };
}

// ── TOTP (RFC 6238) ──────────────────────────────────────────────────────────
// Authenticator apps (Google Authenticator, Authy, Apple Passwords, …) derive a
// rolling 6-digit code from the shared secret.

const TOTP_ISSUER = "isputnik.home";

// Drift tolerance, in SECONDS either side of now. otplib 12 expressed this as
// `window: 1` (±1 thirty-second step); v13 counts seconds instead, so 30 is the
// same tolerance written in the new unit. Its own default is 0 — the current
// period only — which would reject anyone whose phone clock is a few seconds off.
const TOTP_DRIFT_SECONDS = 30;

// 20 bytes = 160 bits, RFC 4226's recommended size and otplib's own default.
// Pinned explicitly rather than inherited so a future change to the library
// default can't silently move it.
//
// Bigger is not stronger: TOTP is HMAC-SHA1, and HMAC folds any key longer than
// its 64-byte block size down to a 20-byte SHA-1 digest, so entropy past that is
// discarded outright. 20 bytes is the point where the secret stops being the
// weakest link.
const TOTP_SECRET_BYTES = 20;

// otplib 12 minted 10-byte (80-bit) secrets — below RFC 4226's 128-bit minimum,
// which v13 enforces by refusing them outright. Such a secret can no longer be
// verified at all, so an account still carrying one has to re-enroll rather than
// see its codes silently rejected as "wrong". Base32 packs 5 bits per character.
const MIN_TOTP_SECRET_BYTES = 16;

export function totpSecretBytes(secret: string): number {
  const chars = secret.replace(/=+$/, "").replace(/\s+/g, "").length;
  return Math.floor((chars * 5) / 8);
}

/** True for a secret minted before 3.10.3 — unverifiable now; the account must re-enroll. */
export function isLegacyTotpSecret(secret: string): boolean {
  return totpSecretBytes(secret) < MIN_TOTP_SECRET_BYTES;
}

export function generateTotpSecret(): string {
  return generateSecret({ length: TOTP_SECRET_BYTES });
}

// The otpauth:// URI an authenticator app imports (also encoded into the setup QR).
export function totpKeyUri(secret: string, accountName: string): string {
  return generateURI({ issuer: TOTP_ISSUER, label: accountName, secret });
}

export function verifyTotp(secret: string, token: string): boolean {
  try {
    const result = verifySync({
      secret,
      token: token.replace(/\s+/g, ""),
      epochTolerance: TOTP_DRIFT_SECONDS
    });
    return Boolean(result?.valid);
  } catch {
    // otplib throws on malformed input (a non-numeric token, or a pre-3.10.3
    // secret it now considers too short) — either way, not a passing code.
    return false;
  }
}

export function totpQrDataUrl(secret: string, accountName: string): Promise<string> {
  return QRCode.toDataURL(totpKeyUri(secret, accountName));
}

// ── Emailed one-time codes ───────────────────────────────────────────────────
// The alternative second factor for people who don't want an authenticator app:
// a 6-digit code mailed to the address they sign in with. There's no shared
// secret to keep — each code is minted per challenge and stored only as a hash,
// exactly like a backup code, so a stolen database yields nothing replayable.
//
// It is the weaker of the two methods (the code crosses the internet in
// plaintext and anyone holding the mailbox holds the factor), and it depends on
// SMTP being up. Both facts are surfaced in the UI where the method is chosen.

// Codes live only as long as it takes an email to arrive and be typed. Longer
// than a TOTP challenge — delivery can take a minute — but still short.
export const EMAIL_CODE_MINUTES = 10;
// A resend budget per challenge, so a caller who knows the password can't use
// the sign-in screen to bombard the owner's inbox.
export const EMAIL_CODE_MAX_SENDS = 3;
export const EMAIL_CODE_RESEND_SECONDS = 60;

export function generateEmailCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashEmailCode(code: string): string {
  return sha256(code.replace(/\D/g, ""));
}

export function verifyEmailCode(storedHash: string, code: string): boolean {
  const candidate = Buffer.from(hashEmailCode(code));
  const expected = Buffer.from(storedHash);
  // Equal-length by construction (both sha256 hex), but guard before comparing.
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

// "sergey@example.com" → "s•••y@example.com". Shown back to the person who just
// passed the password check, so it only has to jog their memory of which inbox.
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  const name = email.slice(0, at);
  const domain = email.slice(at);
  if (name.length <= 2) return `${name[0]}•••${domain}`;
  return `${name[0]}•••${name[name.length - 1]}${domain}`;
}
