// Story guest links: the routes only stories have. They used to sit in the
// shared guest-link engine (library/shared/shares/), which made that engine
// import the stories module while stories imported it back. The engine now
// serves a story link's page, items and zip through the share kind registered
// below (library/shared/share-kinds.ts); what is left here is story-only —
// minting and listing story links, and a shared story's narration clips. The
// URLs are unchanged.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../db.js";
import { parseBody, requestOrigin } from "../../core/shared.js";
import { resolveShareLink } from "../library/shared/share-access.js";
import { registerShareKind } from "../library/shared/share-kinds.js";
import { getStoryAudio, sendNarration } from "./audio.js";
import {
  STORY_SHARE_MODULE,
  buildStorySharePayload,
  createStoryShare,
  loadStoryShareMediaItem,
  storyLinkContext,
  storyShareFiles,
  storyShareTitle
} from "./share.js";
import type { ShareLinkRow, StoryRow } from "../../db/rows.js";

type StoryShareListRow = Pick<ShareLinkRow, "id" | "label" | "created_at" | "expires_at" | "expand_albums"> & {
  story_id: ShareLinkRow["resource_id"];
  story_title: StoryRow["title"];
};

const createStoryLinkSchema = z.object({
  storyId: z.string().trim().min(1).max(64),
  expiresInDays: z.number().int().min(1).max(30).default(30),
  label: z.string().trim().max(100).optional(),
  // Whether a guest may open a whole album/slideshow the story embeds, or only
  // the photos it shows inline. Off by default — see share.ts in modules/stories.
  expandAlbums: z.boolean().default(false)
});

// The same ceiling the engine gives every guest media route (shares/guest-routes.ts): seeking
// within a long recording issues many range requests.
const SHARE_MEDIA_LIMIT = { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } };

/** Hand the guest-link engine what it needs to serve a story link. */
export function registerStoryShareKind(): void {
  registerShareKind({
    module: STORY_SHARE_MODULE,
    noun: "story",
    // A story link has no single library item; the stories module owns the shape
    // of what it serves.
    buildPage: buildStorySharePayload,
    loadMediaItem: loadStoryShareMediaItem,
    // A story's zip is every photo the link exposes — which, with expandAlbums
    // off, is only what the page actually shows.
    listFiles: storyShareFiles,
    title: storyShareTitle
  });
}

export async function storyShareRoutesPlugin(app: FastifyInstance) {
  // A live guest link for a story: the page renders the story as it stands, with
  // its media resolved against this creator's rights at serve time.
  app.post("/api/shares/story", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(createStoryLinkSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid share details", details: parsed.error });
    }
    const user = request.user!;
    const result = createStoryShare(user, {
      storyId: parsed.data.storyId,
      expiresInDays: parsed.data.expiresInDays ?? 30,
      label: parsed.data.label ?? null,
      expandAlbums: parsed.data.expandAlbums
    });
    if (result === "not_found") { return reply.code(404).send({ error: "Story not found" }); }
    if (result === "forbidden") { return reply.code(403).send({ error: "Only the story's author or an admin can share it." }); }

    logActivity({
      event: "share.created",
      actorUserId: user.id,
      targetType: "share_link",
      targetId: result.shareId,
      detail: `Created a live guest link for a story${parsed.data.expandAlbums ? " (albums openable)" : ""}.`,
      ipAddress: request.ip
    });

    const base = requestOrigin(request);
    return reply.code(201).send({
      share: {
        id: result.shareId,
        label: parsed.data.label ?? null,
        expiresAt: result.expiresAt,
        expandAlbums: parsed.data.expandAlbums,
        // Shown exactly once — the raw token is not stored and cannot be re-displayed.
        url: `${base}/share/${result.token}`
      }
    });
  });

  // The caller's active story links.
  app.get("/api/shares/stories", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const rows = db.prepare(`
      SELECT
        share_links.id,
        share_links.resource_id AS story_id,
        share_links.label,
        share_links.created_at,
        share_links.expires_at,
        share_links.expand_albums,
        stories.title AS story_title
      FROM share_links
      JOIN stories ON stories.id = share_links.resource_id
      WHERE share_links.created_by = ? AND share_links.module = '${STORY_SHARE_MODULE}'
        AND share_links.revoked_at IS NULL
      ORDER BY share_links.created_at DESC
    `).all(user.id) as StoryShareListRow[];
    const now = Date.now();
    return {
      shares: rows.map((row) => ({
        id: row.id,
        storyId: row.story_id,
        storyTitle: row.story_title,
        label: row.label,
        expandAlbums: row.expand_albums === 1,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        status: new Date(row.expires_at).getTime() <= now ? "expired" : "active"
      }))
    };
  });

  // A shared story's narration. Belonging to THAT story is the authorization,
  // the same rule the item routes use — a clip id from elsewhere 404s.
  app.get("/api/share/:token/audio/:audioId", SHARE_MEDIA_LIMIT, (request, reply) => {
    const { token, audioId } = request.params as { token: string; audioId: string };
    const link = resolveShareLink(token, request);
    if (!link || link.module !== STORY_SHARE_MODULE) {
      reply.code(404).send({ error: "Share not found or expired" });
      return;
    }
    const ctx = storyLinkContext(link);
    const audio = getStoryAudio(audioId);
    if (!ctx || !audio || audio.story_id !== ctx.story.id) {
      reply.code(404).send({ error: "Recording not found" });
      return;
    }
    return sendNarration(request, reply, audio);
  });
}
