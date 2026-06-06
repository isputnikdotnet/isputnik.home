import fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import staticFiles from "@fastify/static";
import { config } from "./config.js";
import { registerAuthDecorators } from "./auth.js";
import { corePlugin } from "./core/index.js";
import { libraryPlugin } from "./modules/library/index.js";
import { collectionsPlugin } from "./modules/collections/index.js";

const app = fastify({
  logger: true,
  trustProxy: true
});

await app.register(cors, {
  origin: config.appUrl,
  credentials: true
});
await app.register(cookie);
await registerAuthDecorators(app);
await app.register(corePlugin);
await app.register(libraryPlugin);
await app.register(collectionsPlugin);

if (config.staticPath) {
  await app.register(staticFiles, {
    root: config.staticPath,
    wildcard: false
  });
  app.setNotFoundHandler((_request, reply) => {
    return reply.sendFile("index.html");
  });
}

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  reply.code(500).send({ error: "Unexpected server error" });
});

await app.listen({ host: config.host, port: config.port });
