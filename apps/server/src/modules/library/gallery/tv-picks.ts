// Photos on the TV (docs/tv-photos-plan.md): a controlled view. A TV never browses the
// gallery; it shows only the slideshows and albums an admin put on the household's
// "On TV" list, each pick for an audience of viewing profiles. A person's own access
// still applies on top: every count and every photo is the viewer's, as on the website.
//
// - store: tv_photo_picks, in TV order;
// - what one session's TV shows (tvPhotosFor), and whether a slideshow's rendered movie
//   may play there: only when the viewer may see every photo baked into it;
// - the fence: a linked TV (a device session) may read nothing in the gallery but its own
//   list and what is on it.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db, logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { getSections } from "../../../core/sections.js";
import { addSessionGuard } from "../../../core/session-guards.js";
import { sessionLocked } from "../../profiles/fence.js";
import { currentProfileOf, listProfiles, type ViewingProfile } from "../../profiles/store.js";
import { galleryScopeSql, scopeIsEmpty } from "./app-files-access.js";
import { resolveGalleryScopeLibraryIds } from "./catalog-scope.js";
import { listAlbums } from "./albums.js";
import { listSlideshows } from "./slideshows.js";

export const TV_PICKS_MAX = 40;

export type TvAudience = "everyone" | "grownups" | "chosen";
type PickKind = "slideshow" | "album";

interface PickRow {
  id: string;
  slideshow_id: string | null;
  album_id: string | null;
  position: number;
  audience: TvAudience;
  profile_ids: string | null;
}

/** '' in profileIds stands for someone watching as themselves, with no profile worn. */
export const NO_PROFILE = "";

const kindOf = (row: PickRow): PickKind => (row.slideshow_id ? "slideshow" : "album");
const refOf = (row: PickRow): string => (row.slideshow_id ?? row.album_id)!;

function profileIdsOf(row: PickRow): string[] {
  if (row.audience !== "chosen" || !row.profile_ids) return [];
  try {
    const value = JSON.parse(row.profile_ids);
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function allPicks(): PickRow[] {
  return db.prepare("SELECT id, slideshow_id, album_id, position, audience, profile_ids FROM tv_photo_picks ORDER BY position, created_at").all() as PickRow[];
}

/** Whether a pick is for the session watching: its profile, or none. Restricted
 *  profiles see only what names them or is for everyone. */
export function audienceIncludes(row: Pick<PickRow, "audience" | "profile_ids">, profile: ViewingProfile | null): boolean {
  if (row.audience === "everyone") return true;
  if (row.audience === "grownups") return !profile?.restricted;
  return profileIdsOf(row as PickRow).includes(profile?.id ?? NO_PROFILE);
}

/** How many of a slideshow's photos exist at all, whoever looks: what its movie holds. */
function slideshowWholeCount(slideshowId: string): number {
  return (db.prepare(`
    SELECT COUNT(*) AS n FROM gallery_slideshow_items
    JOIN library_items ON library_items.id = gallery_slideshow_items.item_id AND library_items.deleted_at IS NULL
    WHERE gallery_slideshow_items.slideshow_id = ?
  `).get(slideshowId) as { n: number }).n;
}

/** Whether this viewer may see every photo in a slideshow: only then may its rendered
 *  movie, which has them all baked in, play on a TV. One slideshow, counted directly, so
 *  it is cheap enough to ask on every byte range of the movie. */
export function viewerSeesWholeSlideshow(user: { id: string; role: string }, slideshowId: string): boolean {
  const whole = slideshowWholeCount(slideshowId);
  if (whole === 0) return false;
  const libIds = resolveGalleryScopeLibraryIds(user);
  if (scopeIsEmpty(libIds)) return false;
  const scope = galleryScopeSql(libIds);
  const visible = (db.prepare(`
    SELECT COUNT(*) AS n FROM gallery_slideshow_items
    JOIN library_items ON library_items.id = gallery_slideshow_items.item_id AND library_items.deleted_at IS NULL
    WHERE gallery_slideshow_items.slideshow_id = ? AND ${scope.sql}
  `).get(slideshowId, ...scope.params) as { n: number }).n;
  return visible === whole;
}

export interface TvPhotoItem {
  pickId: string;
  kind: PickKind;
  id: string;
  name: string;
  coverUrl: string | null;
  /** The photos this viewer may see in it. */
  itemCount: number;
  /** Slideshows: per-slide seconds, transition and music, for the live viewer. */
  slideSeconds?: number;
  transition?: string;
  musicTrackId?: string | null;
  /** Slideshows: the rendered movie may play, because the viewer sees every photo in it. */
  movie?: boolean;
}

/** What one session's TV shows: the picks for its audience, each as this viewer sees it.
 *  A pick the viewer sees nothing of is left out. */
export function tvPhotosFor(user: { id: string; role: string }, profile: ViewingProfile | null): TvPhotoItem[] {
  if (!getSections().gallery) return [];
  const picks = allPicks().filter((row) => audienceIncludes(row, profile));
  if (picks.length === 0) return [];
  const libIds = resolveGalleryScopeLibraryIds(user);
  // The lists count only what this viewer may see; an empty one is left out below
  // (they keep a creator's own empty slideshow or album in, which a TV has no use for).
  const slideshows = new Map(listSlideshows(user, libIds).map((entry) => [entry.id, entry]));
  const albums = new Map(listAlbums(user, libIds).map((entry) => [entry.id, entry]));
  return picks.flatMap((row): TvPhotoItem[] => {
    if (row.slideshow_id) {
      const show = slideshows.get(row.slideshow_id);
      if (!show || show.itemCount === 0) return [];
      return [{
        pickId: row.id,
        kind: "slideshow",
        id: show.id,
        name: show.name,
        coverUrl: show.coverUrl,
        itemCount: show.itemCount,
        slideSeconds: show.slideSeconds,
        transition: show.transition,
        musicTrackId: show.musicTrackId,
        movie: show.renderStatus === "ready" && show.itemCount === slideshowWholeCount(show.id)
      }];
    }
    const album = albums.get(row.album_id!);
    if (!album || album.itemCount === 0) return [];
    return [{ pickId: row.id, kind: "album", id: album.id, name: album.name, coverUrl: album.coverUrl, itemCount: album.itemCount }];
  });
}

// ── The fence for linked TVs ─────────────────────────────────────────────────

const GALLERY = "/api/library/gallery/";

/** What a TV may read in the gallery, as a path decides it; null when it isn't asked. */
export function tvGalleryRefusal(path: string, method: string, allowed: { slideshows: Set<string>; albums: Set<string>; musics: Set<string>; assets: () => Set<string>; movie: (slideshowId: string) => boolean }): string | null {
  if (!path.startsWith(GALLERY)) return null;
  const refused = "On a TV, photos are only what's on its list.";
  if (method !== "GET" && method !== "HEAD") return refused;
  const rest = path.slice(GALLERY.length);
  if (rest === "tv") return null;
  let match = /^slideshows\/([^/]+)(\/movie)?$/.exec(rest);
  if (match) {
    const id = decodeURIComponent(match[1]!);
    if (!allowed.slideshows.has(id)) return refused;
    // The movie only when the viewer may see every photo in it (it can't leave any out).
    return match[2] && !allowed.movie(id) ? refused : null;
  }
  match = /^albums\/([^/]+)$/.exec(rest);
  if (match) return allowed.albums.has(decodeURIComponent(match[1]!)) ? null : refused;
  match = /^music\/([^/]+)\/stream$/.exec(rest);
  if (match) return allowed.musics.has(decodeURIComponent(match[1]!)) ? null : refused;
  match = /^assets\/([^/]+)(\/file|\/motion)?$/.exec(rest);
  if (match) return allowed.assets().has(decodeURIComponent(match[1]!)) ? null : refused;
  return refused;
}

/** The session guard (core/session-guards.ts): a device session's gallery requests. */
function tvFence(request: FastifyRequest): string | null {
  if (request.sessionKind !== "device" || !request.url.startsWith(GALLERY)) return null;
  const path = request.url.split("?")[0]!;
  const profile = currentProfileOf(request);
  const picks = allPicks().filter((row) => audienceIncludes(row, profile));
  const slideshows = new Set(picks.flatMap((row) => (row.slideshow_id ? [row.slideshow_id] : [])));
  const albums = new Set(picks.flatMap((row) => (row.album_id ? [row.album_id] : [])));
  const musics = new Set(slideshows.size === 0 ? [] : (db.prepare(
    `SELECT music_track_id AS id FROM gallery_slideshows WHERE music_track_id IS NOT NULL AND id IN (${[...slideshows].map(() => "?").join(", ")})`
  ).all(...slideshows) as { id: string }[]).map((row) => row.id));
  // Photos asked for one by one: only those in a pick on this TV's list (the route then
  // checks the person may see the photo at all).
  const assets = () => new Set([
    ...(slideshows.size === 0 ? [] : (db.prepare(`SELECT item_id AS id FROM gallery_slideshow_items WHERE slideshow_id IN (${[...slideshows].map(() => "?").join(", ")})`).all(...slideshows) as { id: string }[]).map((row) => row.id)),
    ...(albums.size === 0 ? [] : (db.prepare(`SELECT item_id AS id FROM gallery_album_items WHERE album_id IN (${[...albums].map(() => "?").join(", ")})`).all(...albums) as { id: string }[]).map((row) => row.id))
  ]);
  const movie = (slideshowId: string) => viewerSeesWholeSlideshow(request.user!, slideshowId);
  return tvGalleryRefusal(path, request.method, { slideshows, albums, musics, assets, movie });
}

// ── Routes ───────────────────────────────────────────────────────────────────

const audienceSchema = z.object({
  audience: z.enum(["everyone", "grownups", "chosen"]).default("grownups"),
  profileIds: z.array(z.string().max(64)).max(32).optional()
});
const addSchema = audienceSchema.extend({
  slideshowId: z.string().min(1).max(64).optional(),
  albumId: z.string().min(1).max(64).optional()
}).refine((body) => Boolean(body.slideshowId) !== Boolean(body.albumId), "Name one slideshow or one album");
const orderSchema = z.object({ ids: z.array(z.string().min(1).max(64)).max(TV_PICKS_MAX * 2) });

/** Profile ids that exist (and '' for no profile): a pick never names anything else. */
function knownProfileIds(ids: string[] | undefined): string[] {
  const known = new Set([NO_PROFILE, ...listProfiles().map((profile) => profile.id)]);
  return [...new Set(ids ?? [])].filter((id) => known.has(id));
}

export async function galleryTvRoutesPlugin(app: FastifyInstance) {
  addSessionGuard(tvFence);

  /** Changing the list is an admin's, at a keyboard (requireAdmin refuses a TV), and not
   *  from inside a locked profile. */
  const manager = async (request: FastifyRequest, reply: FastifyReply) => {
    await app.requireAdmin(request, reply);
    if (reply.sent) return;
    if (sessionLocked(request)) return reply.code(403).send({ error: "Leave the restricted profile first.", reason: "pin_needed" });
  };

  /** The list as the website's On TV panel edits it, named as the admin sees things. */
  const panel = (user: { id: string; role: string }) => {
    const libIds = resolveGalleryScopeLibraryIds(user);
    const slideshows = new Map(listSlideshows(user, libIds).map((entry) => [entry.id, entry]));
    const albums = new Map(listAlbums(user, libIds).map((entry) => [entry.id, entry]));
    return {
      picks: allPicks().map((row) => {
        const entry = row.slideshow_id ? slideshows.get(row.slideshow_id) : albums.get(row.album_id!);
        return {
          id: row.id,
          kind: kindOf(row),
          refId: refOf(row),
          name: entry?.name ?? null,
          coverUrl: entry?.coverUrl ?? null,
          itemCount: entry?.itemCount ?? 0,
          audience: row.audience,
          profileIds: profileIdsOf(row)
        };
      }),
      max: TV_PICKS_MAX
    };
  };

  // What this TV (or browser) shows on its Photos tab.
  app.get("/api/library/gallery/tv", { preHandler: app.authenticate }, async (request) => ({
    items: tvPhotosFor(request.user!, currentProfileOf(request))
  }));

  app.get("/api/library/gallery/tv/picks", { preHandler: manager }, async (request) => panel(request.user!));

  app.post("/api/library/gallery/tv/picks", { preHandler: manager }, async (request, reply) => {
    const parsed = parseBody(addSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid pick", details: parsed.error });
    const { slideshowId, albumId, audience, profileIds } = parsed.data;
    if (allPicks().length >= TV_PICKS_MAX) return reply.code(400).send({ error: `The TV list holds at most ${TV_PICKS_MAX}.` });
    const target = slideshowId
      ? db.prepare("SELECT name FROM gallery_slideshows WHERE id = ?").get(slideshowId) as { name: string } | undefined
      : db.prepare("SELECT name FROM gallery_albums WHERE id = ?").get(albumId) as { name: string } | undefined;
    if (!target) return reply.code(404).send({ error: slideshowId ? "Slideshow not found" : "Album not found" });
    const already = db.prepare("SELECT 1 FROM tv_photo_picks WHERE slideshow_id = ? OR album_id = ?").get(slideshowId ?? null, albumId ?? null);
    if (already) return reply.code(409).send({ error: "It's already on the TV." });
    const position = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM tv_photo_picks").get() as { next: number }).next;
    db.prepare(`
      INSERT INTO tv_photo_picks (id, slideshow_id, album_id, position, audience, profile_ids, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(nanoid(), slideshowId ?? null, albumId ?? null, position, audience,
      audience === "chosen" ? JSON.stringify(knownProfileIds(profileIds)) : null, request.user!.id);
    logActivity({ event: "gallery.tv.added", actorUserId: request.user!.id, targetType: slideshowId ? "gallery_slideshow" : "gallery_album", targetId: (slideshowId ?? albumId)!, detail: `Put "${target.name}" on the TV.`, ipAddress: request.ip });
    return reply.code(201).send(panel(request.user!));
  });

  app.patch("/api/library/gallery/tv/picks/:id", { preHandler: manager }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = parseBody(audienceSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid audience", details: parsed.error });
    const { audience, profileIds } = parsed.data;
    const changed = db.prepare("UPDATE tv_photo_picks SET audience = ?, profile_ids = ? WHERE id = ?")
      .run(audience, audience === "chosen" ? JSON.stringify(knownProfileIds(profileIds)) : null, id).changes;
    if (!changed) return reply.code(404).send({ error: "Not on the TV" });
    return panel(request.user!);
  });

  app.delete("/api/library/gallery/tv/picks/:id", { preHandler: manager }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = db.prepare("SELECT slideshow_id, album_id FROM tv_photo_picks WHERE id = ?").get(id) as Pick<PickRow, "slideshow_id" | "album_id"> | undefined;
    if (!row) return reply.code(404).send({ error: "Not on the TV" });
    db.prepare("DELETE FROM tv_photo_picks WHERE id = ?").run(id);
    logActivity({ event: "gallery.tv.removed", actorUserId: request.user!.id, targetType: row.slideshow_id ? "gallery_slideshow" : "gallery_album", targetId: (row.slideshow_id ?? row.album_id)!, detail: "Took it off the TV.", ipAddress: request.ip });
    return panel(request.user!);
  });

  app.put("/api/library/gallery/tv/picks/order", { preHandler: manager }, async (request, reply) => {
    const parsed = parseBody(orderSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid order", details: parsed.error });
    const update = db.prepare("UPDATE tv_photo_picks SET position = ? WHERE id = ?");
    db.transaction(() => parsed.data.ids.forEach((id, index) => update.run(index, id)))();
    return panel(request.user!);
  });
}
