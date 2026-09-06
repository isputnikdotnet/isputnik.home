// Drop link routes — docs/photo-inbox-proposal.md, phase 3. Two halves: the
// Inbox's own (create and list, signed in, the reviewer's right) and the public
// pair a guest uses (read the link, upload through it). The public routes carry no
// preHandler — that is what makes them public — and a tight rate limit each, like
// the invite and share pages. Revoking a drop link is the general
// DELETE /api/shares/:id, which every guest link already answers to.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseBody, requestOrigin } from "../../../core/shared.js";
import { createDropLink, dropLinkView, listDropLinks, receiveDrop } from "./drop-links.js";

const createSchema = z.object({
  label: z.string().trim().max(100).optional(),
  // Longer than a viewing link's 30 days: a box of prints takes a while to scan.
  expiresInDays: z.number().int().min(1).max(90).default(14),
  maxFiles: z.number().int().min(1).max(10000).nullable().optional(),
  maxMB: z.number().int().min(1).max(102400).nullable().optional(),
  oneTime: z.boolean().default(false)
});

// The page reads the link once and again after each batch; uploads are rarer
// and heavier, so they get the tighter of the two.
const DROP_PAGE_LIMIT = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };
const DROP_UPLOAD_LIMIT = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

export async function galleryDropRoutesPlugin(app: FastifyInstance) {
  app.get("/api/library/gallery/inbox/:id/drop-links", { preHandler: app.authenticate }, async (request, reply) => {
    const libraryId = (request.params as { id: string }).id;
    const links = listDropLinks(request.user!, libraryId);
    if (!links) return reply.code(404).send({ error: "Photo Inbox not found" });
    return { links };
  });

  // Mint a link. The raw token is in the reply and nowhere else — only its hash
  // is stored, so this is the one time the address can be copied.
  app.post("/api/library/gallery/inbox/:id/drop-links", { preHandler: app.authenticate }, async (request, reply) => {
    const libraryId = (request.params as { id: string }).id;
    const parsed = parseBody(createSchema, request.body ?? {});
    if (parsed.error) return reply.code(400).send({ error: "Invalid drop link", details: parsed.error });
    const outcome = createDropLink(request.user!, {
      libraryId,
      label: parsed.data.label || null,
      expiresInDays: parsed.data.expiresInDays ?? 14,
      maxFiles: parsed.data.maxFiles ?? null,
      maxBytes: parsed.data.maxMB == null ? null : parsed.data.maxMB * 1024 * 1024,
      oneTime: parsed.data.oneTime === true
    });
    if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.error });
    return reply.code(201).send({
      link: outcome.link,
      url: `${requestOrigin(request)}/drop/${outcome.token}`
    });
  });

  // ── Public ──────────────────────────────────────────────────────────────

  app.get("/api/drop/:token", DROP_PAGE_LIMIT, async (request, reply) => {
    const token = (request.params as { token: string }).token;
    const view = dropLinkView(token, request);
    if (!view) return reply.code(404).send({ error: "This link isn't valid any more." });
    return view;
  });

  app.post("/api/drop/:token/upload", DROP_UPLOAD_LIMIT, async (request, reply) => {
    const token = (request.params as { token: string }).token;
    const outcome = await receiveDrop(token, request);
    if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.error });
    return reply.code(201).send(outcome);
  });
}
