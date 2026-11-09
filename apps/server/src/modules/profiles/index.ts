// Viewing profiles (docs/tv-profiles-plan.md): the household's, Netflix-style. An admin
// sets them up on the video page (Customize › Profiles) along with the household PIN;
// every TV and browser can wear one. Wearing one narrows video for that session only.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../db.js";
import { verifyPassword } from "../../crypto.js";
import type { UserRow } from "../../db/rows.js";
import { parseBody } from "../../core/shared.js";
import { addSessionGuard } from "../../core/session-guards.js";
import { profileFence, sessionLocked } from "./fence.js";
import { PIN_PATTERN, checkPin, clearPin, hasPin, setPin, type PinCheck } from "./pins.js";
import {
  PROFILES_MAX,
  PROFILE_AVATARS,
  createProfile,
  deleteProfile,
  getProfile,
  listProfiles,
  profileInputSchema,
  reorderProfiles,
  setSessionProfile,
  updateProfile
} from "./store.js";

const switchSchema = z.object({
  profileId: z.string().min(1).max(64).nullable(),
  /** Needed to leave a restricted profile once the household has a PIN. */
  pin: z.string().max(16).optional()
});
const orderSchema = z.object({ ids: z.array(z.string().min(1).max(64)).max(PROFILES_MAX * 2) });
const pinCheckSchema = z.object({ pin: z.string().max(16) });
const pinSetSchema = z.object({ pin: z.string().regex(PIN_PATTERN), currentPassword: z.string().min(1).max(1024) });
const pinClearSchema = z.object({ currentPassword: z.string().min(1).max(1024) });

export async function profilesPlugin(app: FastifyInstance) {
  addSessionGuard(profileFence);

  const answer = (request: FastifyRequest) => {
    // Read afresh, not from the request's memo: a switch has just changed it.
    const current = request.profileId ? getProfile(request.profileId) : null;
    const pinSet = hasPin();
    return {
      profiles: listProfiles(),
      current: current?.id ?? null,
      avatars: PROFILE_AVATARS,
      max: PROFILES_MAX,
      /** An admin at a keyboard (requireAdmin refuses a TV) who isn't in a locked profile. */
      editable: request.user!.role === "admin" && request.sessionKind !== "device" && !(current?.restricted && pinSet),
      /** The household has a PIN for leaving restricted profiles. */
      pinSet,
      /** Leaving the profile worn now needs that PIN. */
      locked: Boolean(current?.restricted) && pinSet
    };
  };

  /** Changing profiles or the PIN is an admin's, and not from inside a locked profile
   *  (an admin's browser left in Kids is not a way to loosen Kids). */
  const manager = async (request: FastifyRequest, reply: FastifyReply) => {
    await app.requireAdmin(request, reply);
    if (reply.sent) return;
    if (sessionLocked(request)) return reply.code(403).send({ error: "Leave the restricted profile first.", reason: "pin_needed" });
  };

  app.get("/api/profiles", { preHandler: app.authenticate }, async (request) => answer(request));

  app.post("/api/profiles", { preHandler: manager }, async (request, reply) => {
    const parsed = parseBody(profileInputSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid profile", details: parsed.error });
    if (listProfiles().length >= PROFILES_MAX) return reply.code(400).send({ error: `The household has at most ${PROFILES_MAX} profiles.` });
    const profile = createProfile(profileInputSchema.parse(parsed.data), request.user!.id);
    logActivity({ event: "profiles.created", actorUserId: request.user!.id, targetType: "viewing_profile", targetId: profile.id, detail: `Created the viewing profile "${profile.name}".`, ipAddress: request.ip });
    return reply.code(201).send({ profile, ...answer(request) });
  });

  app.patch("/api/profiles/:id", { preHandler: manager }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = parseBody(profileInputSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid profile", details: parsed.error });
    const profile = updateProfile(id, profileInputSchema.parse(parsed.data));
    if (!profile) return reply.code(404).send({ error: "Profile not found" });
    logActivity({ event: "profiles.changed", actorUserId: request.user!.id, targetType: "viewing_profile", targetId: id, detail: `Changed the viewing profile "${profile.name}".`, ipAddress: request.ip });
    return { profile, ...answer(request) };
  });

  app.delete("/api/profiles/:id", { preHandler: manager }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const profile = getProfile(id);
    if (!profile || !deleteProfile(id)) return reply.code(404).send({ error: "Profile not found" });
    logActivity({ event: "profiles.deleted", actorUserId: request.user!.id, targetType: "viewing_profile", targetId: id, detail: `Deleted the viewing profile "${profile.name}".`, ipAddress: request.ip });
    return answer(request);
  });

  app.put("/api/profiles/order", { preHandler: manager }, async (request, reply) => {
    const parsed = parseBody(orderSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid order", details: parsed.error });
    reorderProfiles(parsed.data.ids);
    return answer(request);
  });

  /** A wrong or locked-out PIN as a screen shows it: 403 with tries left, 429 while locked. */
  const pinRefused = (request: FastifyRequest, reply: FastifyReply, check: Exclude<PinCheck, { ok: true }>) => {
    if (check.locked) {
      logActivity({ event: "profiles.pin_locked", actorUserId: request.user!.id, targetType: "user", targetId: request.user!.id, detail: "Too many wrong viewing-profile PINs; entry is locked for a while.", ipAddress: request.ip });
      return reply.code(429).send({ error: "Too many wrong PINs. Try again later.", reason: "pin_locked", lockedUntil: check.lockedUntil });
    }
    return reply.code(403).send({ error: "That PIN isn't right.", reason: "pin_wrong", triesLeft: check.triesLeft });
  };

  // Who's watching, on a TV or on the video page. Going into a profile is free; leaving
  // a restricted one needs the household PIN once there is one.
  app.post("/api/profiles/switch", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(switchSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid profile", details: parsed.error });
    const { profileId, pin } = parsed.data;
    if (profileId !== null && !getProfile(profileId)) return reply.code(404).send({ error: "Profile not found" });
    if (profileId !== request.profileId && sessionLocked(request)) {
      if (pin === undefined) return reply.code(403).send({ error: "Enter the PIN to leave this profile.", reason: "pin_needed" });
      const check = await checkPin(pin);
      if (!check.ok) return pinRefused(request, reply, check);
    }
    setSessionProfile(request.sessionId!, profileId);
    request.profileId = profileId;
    return answer(request);
  });

  // A TV asks this before what it does on its own side of a locked profile: choosing
  // another person linked on it, linking someone new. Counts a wrong PIN like a switch.
  app.post("/api/profiles/pin/check", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(pinCheckSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid PIN", details: parsed.error });
    if (!sessionLocked(request)) return { ok: true };
    const check = await checkPin(parsed.data.pin);
    return check.ok ? { ok: true } : pinRefused(request, reply, check);
  });

  /** Setting or removing the PIN costs the admin's password. */
  const passwordRefused = async (request: FastifyRequest, reply: FastifyReply, password: string) => {
    const user = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(request.user!.id) as Pick<UserRow, "password_hash"> | undefined;
    if (user && (await verifyPassword(password, user.password_hash))) return null;
    return reply.code(403).send({ error: "That password isn't right.", reason: "password_wrong" });
  };

  app.put("/api/profiles/pin", { preHandler: manager }, async (request, reply) => {
    const parsed = parseBody(pinSetSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "A PIN is 4 to 8 digits.", details: parsed.error });
    const wrong = await passwordRefused(request, reply, parsed.data.currentPassword);
    if (wrong) return wrong;
    const changed = hasPin();
    await setPin(parsed.data.pin, request.user!.id);
    logActivity({ event: "profiles.pin_set", actorUserId: request.user!.id, targetType: "viewing_profile_pin", targetId: "household", detail: changed ? "Changed the viewing profiles PIN." : "Set a viewing profiles PIN.", ipAddress: request.ip });
    return answer(request);
  });

  app.delete("/api/profiles/pin", { preHandler: manager }, async (request, reply) => {
    const parsed = parseBody(pinClearSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Enter your password", details: parsed.error });
    const wrong = await passwordRefused(request, reply, parsed.data.currentPassword);
    if (wrong) return wrong;
    clearPin();
    logActivity({ event: "profiles.pin_removed", actorUserId: request.user!.id, targetType: "viewing_profile_pin", targetId: "household", detail: "Removed the viewing profiles PIN.", ipAddress: request.ip });
    return answer(request);
  });
}
