// The For you page's reads and the bell — docs/for-you-plan.md.
import type { FastifyInstance } from "fastify";
import { countUnseenForYou, loadForYouRows, markForYouSeen } from "./for-you.js";

export async function forYouPlugin(app: FastifyInstance) {
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
