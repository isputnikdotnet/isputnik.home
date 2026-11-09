// What a linked TV in a LOCKED profile (a restricted one, with the household PIN set) is
// refused besides switching away without the PIN: the account's own settings, and
// signing out — on a TV with several people linked, unlinking Kids would land on the
// next person's account. The owner can still remove the TV from Profile › Security on
// their own device.
//
// Only a TV: in a browser a profile is a choice on the video page, and the rest of the
// site stays the account's (a child with their own browser gets their own account).
import type { FastifyRequest } from "fastify";
import { hasPin } from "./pins.js";
import { currentProfileOf } from "./store.js";

const LOCKED_OUT = ["/api/profile", "/api/account", "/api/auth/logout"];

/** A prefix fences "/x" and "/x/…", never "/xs". */
function matches(path: string, prefix: string): boolean {
  if (!path.startsWith(prefix)) return false;
  const next = path.charAt(prefix.length);
  return next === "" || next === "/" || next === "?";
}

export function lockedOut(path: string): boolean {
  return LOCKED_OUT.some((prefix) => matches(path, prefix));
}

/** Whether leaving the profile this session wears needs the household PIN. */
export function sessionLocked(request: FastifyRequest): boolean {
  return Boolean(currentProfileOf(request)?.restricted) && hasPin();
}

/** The session guard (core/session-guards.ts). */
export function profileFence(request: FastifyRequest): string | null {
  if (request.sessionKind !== "device" || !lockedOut(request.url)) return null;
  return sessionLocked(request) ? "This profile is locked. Enter the PIN to leave it first." : null;
}
