import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { authenticator } from "otplib";
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
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
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
// rolling 6-digit code from the shared secret. A ±1 step window tolerates modest
// clock drift between the phone and the server.
authenticator.options = { window: 1 };

const TOTP_ISSUER = "isputnik.home";

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

// The otpauth:// URI an authenticator app imports (also encoded into the setup QR).
export function totpKeyUri(secret: string, accountName: string): string {
  return authenticator.keyuri(accountName, TOTP_ISSUER, secret);
}

export function verifyTotp(secret: string, token: string): boolean {
  try {
    return authenticator.verify({ token: token.replace(/\s+/g, ""), secret });
  } catch {
    // otplib throws on malformed input (e.g. non-numeric) — treat as a failed code.
    return false;
  }
}

export function totpQrDataUrl(secret: string, accountName: string): Promise<string> {
  return QRCode.toDataURL(totpKeyUri(secret, accountName));
}
