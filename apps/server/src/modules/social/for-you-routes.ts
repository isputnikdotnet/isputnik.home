// The For you page's reads and the bell — docs/for-you-plan.md.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseBody } from "../../core/shared.js";
import { countUnseenForYou, dismissDelivery, loadForYouRows, markForYouSeen } from "./for-you.js";

const dismissSchema = z.object({
  libraryId: z.string().trim().min(1).max(64),
  folder: z.string().max(1024)
});

export async function forYouPlugin(app: FastifyInstance) {
  // "Not now" on a delivery row: hidden until more photos arrive in it.
  app.post("/api/for-you/deliveries/dismiss", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(dismissSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid delivery", details: parsed.error });
    if (!dismissDelivery(request.user!, parsed.data.libraryId, parsed.data.folder)) {
      return reply.code(404).send({ error: "That delivery is not waiting on you." });
    }
    return reply.send({ ok: true });
  });

  // Everything waiting on this person, newest first. Standing access ("things
  // you can open") is /api/shared-with-me, as before.
  app.get("/api/for-you", { preHandler: app.authenticate }, async (request) => ({
    waiting: loadForYouRows(request.user!)
  }));

  // The bell. A count of what has not been LOOKED AT, not of what has not been
  // acted on — so it clears when you open the page and never climbs to 47.
  app.get("/api/social/inbox/summary", { preHandler: app.authenticate }, async (request) => ({
    unseen: countUnseenForYou(request.user!)
  }));

  // Opening the page stamps everything on it as seen. Deliberately not per row:
  // the dot means "there is something new here", and once you have looked,
  // there isn't.
  app.post("/api/social/inbox/seen", { preHandler: app.authenticate }, async (request, reply) => {
    markForYouSeen(request.user!);
    return reply.send({ ok: true });
  });
}
