// Viewing profiles (docs/tv-profiles-plan.md, phase P1). Made and changed from a
// browser (Profile › Viewing profiles); worn by a linked TV, which switches between
// them. A TV can't edit them, so a child holding the remote can't loosen Kids.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { logActivity } from "../../db.js";
import { parseBody } from "../../core/shared.js";
import { addSessionGuard } from "../../core/session-guards.js";
import { profileFence } from "./fence.js";
import {
  PROFILES_MAX,
  PROFILE_AVATARS,
  createProfile,
  deleteProfile,
  effectiveSections,
  getProfile,
  listProfiles,
  profileInputSchema,
  reorderProfiles,
  setSessionProfile,
  updateProfile
} from "./store.js";

const switchSchema = z.object({ profileId: z.string().min(1).max(64).nullable() });
const orderSchema = z.object({ ids: z.array(z.string().min(1).max(64)).max(PROFILES_MAX * 2) });

export async function profilesPlugin(app: FastifyInstance) {
  addSessionGuard(profileFence);

  /** Editing is for someone at a keyboard: a linked TV only wears profiles. */
  const browserOnly = (request: FastifyRequest, reply: FastifyReply) =>
    request.sessionKind === "device"
      ? reply.code(403).send({ error: "Profiles are changed in Profile on your own device, not on a TV." })
      : null;

  const answer = (request: FastifyRequest) => {
    // Read afresh, not from the request's memo: a switch has just changed it.
    const current = request.profileId ? getProfile(request.profileId, request.user!.id) : null;
    return {
      profiles: listProfiles(request.user!.id),
      current: current?.id ?? null,
      // What the screen should offer as this session is now.
      sections: effectiveSections(current),
      avatars: PROFILE_AVATARS,
      max: PROFILES_MAX,
      editable: request.sessionKind !== "device"
    };
  };

  app.get("/api/profiles", { preHandler: app.authenticate }, async (request) => answer(request));

  app.post("/api/profiles", { preHandler: app.authenticate }, async (request, reply) => {
    const refused = browserOnly(request, reply);
    if (refused) return refused;
    const parsed = parseBody(profileInputSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid profile", details: parsed.error });
    if (listProfiles(request.user!.id).length >= PROFILES_MAX) {
      return reply.code(400).send({ error: `An account has at most ${PROFILES_MAX} profiles.` });
    }
    const profile = createProfile(profileInputSchema.parse(parsed.data), request.user!);
    logActivity({ event: "profiles.created", actorUserId: request.user!.id, targetType: "viewing_profile", targetId: profile.id, detail: `Created the viewing profile "${profile.name}".`, ipAddress: request.ip });
    return reply.code(201).send({ profile, ...answer(request) });
  });

  app.patch("/api/profiles/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const refused = browserOnly(request, reply);
    if (refused) return refused;
    const { id } = request.params as { id: string };
    const parsed = parseBody(profileInputSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid profile", details: parsed.error });
    const profile = updateProfile(id, profileInputSchema.parse(parsed.data), request.user!);
    if (!profile) return reply.code(404).send({ error: "Profile not found" });
    logActivity({ event: "profiles.changed", actorUserId: request.user!.id, targetType: "viewing_profile", targetId: id, detail: `Changed the viewing profile "${profile.name}".`, ipAddress: request.ip });
    return { profile, ...answer(request) };
  });

  app.delete("/api/profiles/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const refused = browserOnly(request, reply);
    if (refused) return refused;
    const { id } = request.params as { id: string };
    const profile = getProfile(id, request.user!.id);
    if (!profile || !deleteProfile(id, request.user!.id)) return reply.code(404).send({ error: "Profile not found" });
    logActivity({ event: "profiles.deleted", actorUserId: request.user!.id, targetType: "viewing_profile", targetId: id, detail: `Deleted the viewing profile "${profile.name}".`, ipAddress: request.ip });
    return answer(request);
  });

  app.put("/api/profiles/order", { preHandler: app.authenticate }, async (request, reply) => {
    const refused = browserOnly(request, reply);
    if (refused) return refused;
    const parsed = parseBody(orderSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid order", details: parsed.error });
    reorderProfiles(parsed.data.ids, request.user!.id);
    return answer(request);
  });

  // A TV picks who is watching. Only a linked device wears a profile for now
  // (docs/tv-profiles-plan.md, open question 3); leaving a restricted one will
  // need the PIN in phase P2.
  app.post("/api/profiles/switch", { preHandler: app.authenticate }, async (request, reply) => {
    if (request.sessionKind !== "device") return reply.code(403).send({ error: "Profiles are worn by a linked TV." });
    const parsed = parseBody(switchSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid profile", details: parsed.error });
    const { profileId } = parsed.data;
    if (profileId !== null && !getProfile(profileId, request.user!.id)) return reply.code(404).send({ error: "Profile not found" });
    setSessionProfile(request.sessionId!, profileId);
    request.profileId = profileId;
    return answer(request);
  });
}
