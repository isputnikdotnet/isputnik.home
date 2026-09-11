// Family-tree API. Read endpoints are open to every signed-in user. Mutations
// are admin-only by default, with a tag-scoped exception: a user granted edit
// rights on a family tag (see access.ts) may edit tagged persons and add
// relatives to them. Destructive restructuring (deleting people, removing
// relationships), GEDCOM import, sources, and tag assignment stay admin-only.
//
// One file per domain file, as the rest of the module is laid out: persons-routes,
// unions-routes (relations.ts), events-routes, sources-routes, photos-routes,
// gedcom-routes, settings-routes, and editors-routes for branch access (access.ts).
import type { FastifyInstance } from "fastify";
import { registerPersonRoutes } from "./persons-routes.js";
import { registerSettingsRoutes } from "./settings-routes.js";
import { registerPhotoRoutes } from "./photos-routes.js";
import { registerGedcomRoutes } from "./gedcom-routes.js";
import { registerUnionRoutes } from "./unions-routes.js";
import { registerEventRoutes } from "./events-routes.js";
import { registerSourceRoutes } from "./sources-routes.js";
import { registerEditorRoutes } from "./editors-routes.js";

export async function familyTreeRoutesPlugin(app: FastifyInstance) {
  // Raw image bodies for the portrait upload (parsers are plugin-scoped).
  app.addContentTypeParser(["image/jpeg", "image/png", "image/webp"], { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  // Registered on this same instance, so the portrait upload (persons-routes.ts)
  // sees the content-type parser above — parsers are plugin-scoped.
  registerPersonRoutes(app);
  registerSettingsRoutes(app);
  registerPhotoRoutes(app);
  registerGedcomRoutes(app);
  registerUnionRoutes(app);
  registerEventRoutes(app);
  registerSourceRoutes(app);
  registerEditorRoutes(app);
}
