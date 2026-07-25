import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const keyLength = 64;

export function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, keyLength)) as Buffer;
  return `scrypt:${salt}:${derived.toString("hex")}`;
}

// Spend the same work as a real check when there's no account to check against.
// scrypt is deliberately slow, so returning early on an unknown email answers
// measurably faster than a wrong password for a real one — which turns the login
// route into an oracle for "does this address have an account here". The dummy
// hash is minted once from an unguessable value; the first miss also pays for
// creating it, which only ever makes that one response slower, never faster.
let dummyHash: string | null = null;
export async function verifyDummyPassword(password: string): Promise<false> {
  if (!dummyHash) dummyHash = await hashPassword(crypto.randomBytes(32).toString("hex"));
  try {
    await verifyPassword(password, dummyHash);
  } catch {
    // Result is discarded either way — this call exists for its cost, not its answer.
  }
  return false;
}

export async function verifyPassword(password: string, stored: string) {
  const [scheme, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hash) {
    return false;
  }

  const derived = (await scrypt(password, salt, keyLength)) as Buffer;
  const expected = Buffer.from(hash, "hex");
  return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
}
