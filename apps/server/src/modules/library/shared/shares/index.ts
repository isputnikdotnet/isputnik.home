import type { FastifyInstance } from "fastify";
import { registerShareManageRoutes } from "./manage-routes.js";
import { registerShareGuestRoutes } from "./guest-routes.js";

// Item-level sharing for the digital library, shared across media types. Guest
// links (anonymous, no account) and user-to-user shares both live on the generic
// `share_links` / `shares` tables, keyed by (module, resource_id) — the module is
// the item's library type ("audiobook" | "ebook"), derived once at the seam so a
// share is always stamped with the right namespace. Owner endpoints are type-aware;
// the public guest routes dispatch by the resolved link's module so one set of
// /api/share/:token routes serves every book type.
//   grants.ts              who may widen access, and the one implementation of granting
//                          an item or an album to another account ("Send to" calls it too)
//   gallery-set-shares.ts  quick links: a guest link over a snapshot of selected photos
//   album-shares.ts        live album shares, resolved against the creator's curate rights
//   serve.ts               sending thumbnails and files to a guest, EXIF stripped on the way out
//   manage-routes.ts       the owner's API: /api/shares/*, /api/shared-with-me
//   guest-routes.ts        the public API: /api/share/:token/* (no account)

export async function librarySharesPlugin(app: FastifyInstance) {
  registerShareManageRoutes(app);
  registerShareGuestRoutes(app);
}
