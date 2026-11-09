// The household PIN that lets someone leave a restricted viewing profile
// (docs/tv-profiles-plan.md). One for the household, set by an admin on the video page
// with their password, entered with a remote or a keyboard. Hashed like a password;
// wrong guesses are capped like a sign-in, so four digits can't be walked through
// from the sofa.
import { db } from "../../db.js";
import { hashPassword, verifyPassword } from "../../crypto.js";

/** Wrong PINs in a row before entry locks. */
export const PIN_MAX_FAILURES = 5;
/** How long entry stays locked after that. */
export const PIN_LOCK_MINUTES = 15;
/** Four to eight digits: what a remote's number pad can type. */
export const PIN_PATTERN = /^\d{4,8}$/;

interface PinRow {
  pin_hash: string;
  failures: number;
  locked_until: string | null;
}

const row = () =>
  db.prepare("SELECT pin_hash, failures, locked_until FROM viewing_profile_pin WHERE id = 1").get() as PinRow | undefined;

export function hasPin(): boolean {
  return row() !== undefined;
}

export async function setPin(pin: string, updatedBy: string): Promise<void> {
  const hash = await hashPassword(pin);
  db.prepare(`
    INSERT INTO viewing_profile_pin (id, pin_hash, failures, locked_until, updated_by, updated_at)
    VALUES (1, ?, 0, NULL, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT (id) DO UPDATE SET pin_hash = excluded.pin_hash, failures = 0, locked_until = NULL,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(hash, updatedBy);
}

export function clearPin(): void {
  db.prepare("DELETE FROM viewing_profile_pin").run();
}

export type PinCheck =
  | { ok: true }
  | { ok: false; locked: false; triesLeft: number }
  | { ok: false; locked: true; lockedUntil: string };

/** Checks a PIN, counting a wrong one. With no PIN set, anything passes. */
export async function checkPin(pin: string, now = new Date()): Promise<PinCheck> {
  const stored = row();
  if (!stored) return { ok: true };
  if (stored.locked_until && new Date(stored.locked_until) > now) return { ok: false, locked: true, lockedUntil: stored.locked_until };
  // A lock that has run out starts the count again.
  const failures = stored.locked_until ? 0 : stored.failures;
  if (PIN_PATTERN.test(pin) && (await verifyPassword(pin, stored.pin_hash))) {
    db.prepare("UPDATE viewing_profile_pin SET failures = 0, locked_until = NULL WHERE id = 1").run();
    return { ok: true };
  }
  const next = failures + 1;
  if (next >= PIN_MAX_FAILURES) {
    const lockedUntil = new Date(now.getTime() + PIN_LOCK_MINUTES * 60_000).toISOString();
    db.prepare("UPDATE viewing_profile_pin SET failures = ?, locked_until = ? WHERE id = 1").run(next, lockedUntil);
    return { ok: false, locked: true, lockedUntil };
  }
  db.prepare("UPDATE viewing_profile_pin SET failures = ?, locked_until = NULL WHERE id = 1").run(next);
  return { ok: false, locked: false, triesLeft: PIN_MAX_FAILURES - next };
}
