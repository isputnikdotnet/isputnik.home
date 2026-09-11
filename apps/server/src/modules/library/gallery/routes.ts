// The gallery's HTTP API, one file per area: library-routes.ts, upload-routes.ts,
// browse-routes.ts and asset-routes.ts.
import type { FastifyInstance } from "fastify";
import { registerGalleryLibraryRoutes } from "./library-routes.js";
import { registerGalleryUploadRoutes } from "./upload-routes.js";
import { registerGalleryBrowseRoutes } from "./browse-routes.js";
import { registerGalleryAssetRoutes } from "./asset-routes.js";

export async function galleryRoutesPlugin(app: FastifyInstance) {
  registerGalleryLibraryRoutes(app);
  registerGalleryUploadRoutes(app);
  registerGalleryBrowseRoutes(app);
  registerGalleryAssetRoutes(app);
}
