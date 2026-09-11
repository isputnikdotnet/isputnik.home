// Browsing the gallery: the Timeline, Folders, memories and year reviews, facets
// and the map.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseBody, parseQuery } from "../../../core/shared.js";
import { resolveGalleryScopeLibraryIds, parseLibraryIds, resolveGalleryBrowseLibraryIds } from "./catalog-scope.js";
import {
  queryGalleryTimeline,
  queryGalleryFolders,
  searchGalleryFolders,
  galleryFacets,
  queryGalleryMapPoints
} from "./catalog.js";
import { getGalleryAssets } from "./catalog-asset.js";
import { queryGalleryMemories } from "./catalog-memories.js";
import { EMPTY_GALLERY_FILTERS } from "./catalog-filters.js";
import { suggestGalleryMemories } from "./memories.js";
import { suggestYearReviews, buildYearReview } from "./year-review.js";

// Query strings. `libraryIds` is ONE comma-separated value (parseLibraryIds), and
// the numbers stay strings so junk falls back to each route's default, as it
// always has — the schemas only make sure nothing arrives as a repeated key.
const foldersQuerySchema = z.object({
  libraryIds: z.string().optional(),
  parent: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional()
});
const folderSearchQuerySchema = z.object({
  libraryIds: z.string().optional(),
  q: z.string().optional(),
  limit: z.string().optional()
});
const memoriesQuerySchema = z.object({
  libraryIds: z.string().optional(),
  date: z.string().optional(),
  perYear: z.string().optional()
});
const suggestionsQuerySchema = z.object({ libraryIds: z.string().optional(), limit: z.string().optional() });
const yearReviewQuerySchema = z.object({
  libraryIds: z.string().optional(),
  year: z.string().optional(),
  limit: z.string().optional(),
  maxItems: z.string().optional()
});
const facetsQuerySchema = z.object({ libraryIds: z.string().optional() });
const mapQuerySchema = z.object({ libraryIds: z.string().optional(), kinds: z.string().optional() }); // kinds: comma-separated

export function registerGalleryBrowseRoutes(app: FastifyInstance) {
  // ── Browse: Timeline (by date) and Folders (by on-disk structure) ──

  // Advanced-filter arrays (audiobook-catalog style): each list is optional and
  // bounded so a hostile payload can't inflate the SQL placeholder count.
  const filterList = z.array(z.string().trim().min(1).max(200)).max(100).default([]);
  const timelineSchema = z.object({
    q: z.string().trim().max(200).default(""),
    kinds: z.array(z.enum(["photo", "video", "audio"])).default([]),
    filters: z.object({
      // Which gallery libraries this scopes to — the first cut, so it stays
      // outside the AND-of-facets loop below and reads that way in catalog.ts.
      libraries: filterList,
      people: filterList,
      // 'any' (default) = OR, matching every other facet; 'all' = every selected
      // person must be tagged on the same item.
      peopleMatch: z.enum(["any", "all"]).default("any"),
      tags: filterList,
      years: filterList,
      months: z.array(z.string().regex(/^(0[1-9]|1[0-2])$/)).max(12).default([]),
      taken: z.array(z.string().regex(/^(from|to):\d{4}-\d{2}-\d{2}$/)).max(2).default([]),
      cameras: filterList,
      sizes: z.array(z.enum(["small", "medium", "large", "huge"])).max(4).default([]),
      location: z.array(z.enum(["with_gps", "no_gps"])).max(2).default([]),
      likes: z.array(z.enum(["mine", "anyone", "none"])).max(3).default([])
      // prefault, not default: zod 4 requires a `.default()` to be the finished
      // OUTPUT object, so `{}` no longer type-checks. `.prefault({})` keeps zod 3's
      // behaviour of feeding the value back through the schema, which lets each
      // field's own `.default([])` above stay the single source of truth — spelling
      // the whole object out here would just be a second copy to forget to update.
    }).prefault({}),
    sort: z.enum(["taken", "added"]).default("taken"),
    limit: z.number().int().min(1).max(200).default(80),
    offset: z.number().int().min(0).default(0)
  });

  app.post("/api/library/gallery/timeline", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(timelineSchema, request.body ?? {});
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid timeline query", details: parsed.error });
    }
    const p = parsed.data;
    const libIds = resolveGalleryBrowseLibraryIds(request.user!, p.filters?.libraries ?? []);
    return reply.send(queryGalleryTimeline(request.user!.id, libIds, {
      q: p.q ?? "", kinds: p.kinds ?? [],
      filters: { ...EMPTY_GALLERY_FILTERS, ...p.filters },
      sort: p.sort ?? "taken",
      limit: p.limit ?? 80, offset: p.offset ?? 0
    }));
  });

  app.get("/api/library/gallery/folders", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseQuery(foldersQuerySchema, request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid query", details: parsed.error });
    }
    const qp = parsed.data;
    const libIds = resolveGalleryBrowseLibraryIds(request.user!, parseLibraryIds(qp.libraryIds));
    const limit = Math.min(Math.max(Number.parseInt(qp.limit ?? "80", 10) || 80, 1), 200);
    const offset = Math.max(Number.parseInt(qp.offset ?? "0", 10) || 0, 0);
    // Cap the folder path: real relative paths are short, so a bounded value keeps
    // the LIKE pattern and all downstream string work sane (defense in depth).
    const parent = (qp.parent ?? "").slice(0, 1024);
    return queryGalleryFolders(request.user!.id, libIds, parent, limit, offset);
  });

  // Folder-NAME search, everywhere in scope — "where is the folder called wedding".
  // Separate from /folders above, which browses one level of the tree.
  app.get("/api/library/gallery/folders/search", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseQuery(folderSearchQuerySchema, request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid query", details: parsed.error });
    }
    const qp = parsed.data;
    const libIds = resolveGalleryBrowseLibraryIds(request.user!, parseLibraryIds(qp.libraryIds));
    const limit = Math.min(Math.max(Number.parseInt(qp.limit ?? "100", 10) || 100, 1), 200);
    return searchGalleryFolders(libIds, (qp.q ?? "").slice(0, 200), limit);
  });

  // Memories ("On this day"): past-year assets matching today's month/day, grouped
  // by year. `date` is the client's local calendar date — the server may sit in a
  // different timezone, and "today" belongs to the person looking at the screen.
  // `perYear` caps items per year group (the Home tile only needs one for a cover).
  app.get("/api/library/gallery/memories", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseQuery(memoriesQuerySchema, request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid query", details: parsed.error });
    }
    const qp = parsed.data;
    const libIds = resolveGalleryBrowseLibraryIds(request.user!, parseLibraryIds(qp.libraryIds));
    // A malformed or impossible date (e.g. 2026-99-99 passes the shape check but
    // not Date parsing) falls back to the server's local calendar date.
    let date = qp.date ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
      const now = new Date();
      date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    }
    const perYear = Math.min(Math.max(Number.parseInt(qp.perYear ?? "60", 10) || 60, 1), 200);
    return queryGalleryMemories(request.user!.id, libIds, date, perYear);
  });

  // Suggested memories: event/trip moments clustered from the viewer's accessible
  // items, returned as PROPOSED slideshows (nothing persisted until saved). Distinct
  // from /memories above, which is the date-only "On this day" anniversary feed.
  app.get("/api/library/gallery/memories/suggestions", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseQuery(suggestionsQuerySchema, request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid query", details: parsed.error });
    }
    const qp = parsed.data;
    const libIds = resolveGalleryBrowseLibraryIds(request.user!, parseLibraryIds(qp.libraryIds));
    const limit = Math.min(Math.max(Number.parseInt(qp.limit ?? "12", 10) || 12, 1), 40);
    return { suggestions: suggestGalleryMemories(libIds, { limit }) };
  });

  // "2026 in review": a year's best, proposed as a slideshow. Same contract as the
  // memory suggestions above — nothing is persisted until the user saves one — but
  // built from the household's likes rather than from time clustering, and
  // spread across the calendar so the film covers the year (see year-review.ts).
  //
  // `year` picks one; without it the most recent few years with material are
  // returned, newest first. Each one is a real selection pass, so the count stays
  // small by default.
  app.get("/api/library/gallery/year-review", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseQuery(yearReviewQuerySchema, request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid query", details: parsed.error });
    }
    const qp = parsed.data;
    const libIds = resolveGalleryBrowseLibraryIds(request.user!, parseLibraryIds(qp.libraryIds));
    const maxItems = qp.maxItems ? Math.min(Math.max(Number.parseInt(qp.maxItems, 10) || 60, 12), 200) : undefined;

    const year = Number.parseInt(qp.year ?? "", 10);
    if (Number.isFinite(year) && year > 1800 && year < 3000) {
      const review = buildYearReview(libIds, request.user!.id, year, { maxItems });
      return { suggestions: review ? [review] : [] };
    }
    const limit = Math.min(Math.max(Number.parseInt(qp.limit ?? "3", 10) || 3, 1), 12);
    return { suggestions: suggestYearReviews(libIds, request.user!.id, { limit, maxItems }) };
  });

  // Bulk asset lookup by ids (the suggestion-preview grid fetches a montage's
  // thumbnails in one round trip). Access-filtered per the caller's libraries;
  // inaccessible/unknown ids are silently omitted (bulk contract). Results keep the
  // requested order.
  const lookupSchema = z.object({ itemIds: z.array(z.string().trim().min(1).max(64)).min(1).max(100) });
  app.post("/api/library/gallery/assets/lookup", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(lookupSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid item ids", details: parsed.error });
    }
    const libIds = resolveGalleryScopeLibraryIds(request.user!);
    return reply.send({ assets: getGalleryAssets(request.user!.id, libIds, parsed.data.itemIds) });
  });

  app.get("/api/library/gallery/facets", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseQuery(facetsQuerySchema, request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid query", details: parsed.error });
    }
    const qp = parsed.data;
    const libIds = resolveGalleryBrowseLibraryIds(request.user!, parseLibraryIds(qp.libraryIds));
    return galleryFacets(libIds);
  });

  // Geotagged assets for the map view. Same scope/kind filtering as the timeline;
  // capped so a huge library can't return an unbounded marker payload.
  app.get("/api/library/gallery/map", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseQuery(mapQuerySchema, request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid query", details: parsed.error });
    }
    const qp = parsed.data;
    const libIds = resolveGalleryBrowseLibraryIds(request.user!, parseLibraryIds(qp.libraryIds));
    const kinds = (qp.kinds ?? "").split(",").map((k) => k.trim()).filter((k) => k === "photo" || k === "video" || k === "audio");
    return queryGalleryMapPoints(libIds, { kinds, limit: 5000 });
  });
}
