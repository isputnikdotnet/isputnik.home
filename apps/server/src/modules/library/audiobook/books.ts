import type { FastifyInstance } from "fastify";
import { registerBookRoutes } from "./books-routes.js";
import { registerMetadataRoutes } from "./metadata-routes.js";
import { registerSeriesRoutes } from "./series-routes.js";
import { registerBrowseRoutes } from "./browse-routes.js";

export async function audiobookBooksPlugin(app: FastifyInstance) {
  app.addContentTypeParser(["image/jpeg", "image/png", "image/webp"], { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  registerBookRoutes(app);
  registerMetadataRoutes(app);
  registerSeriesRoutes(app);
  registerBrowseRoutes(app);
}
