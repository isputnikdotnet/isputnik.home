// Review mode's reads that are not an Inbox's — docs/photo-review-plan.md,
// phase 3. (The Inbox walk stays on inbox-routes.ts as `order=review`.)
import type { FastifyInstance } from "fastify";
import { loadAlbumReview } from "./review.js";

export async function galleryReviewRoutesPlugin(app: FastifyInstance) {
  // An album, as Review mode walks it: photos with the unreviewed first, and
  // whether this viewer may write on them.
  app.get("/api/library/gallery/review/album/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const albumId = (request.params as { id: string }).id;
    const review = loadAlbumReview(request.user!, albumId);
    if (!review) return reply.code(404).send({ error: "Album not found" });
    return review;
  });
}
