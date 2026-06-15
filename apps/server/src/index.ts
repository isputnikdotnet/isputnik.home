import fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
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
// Global per-client-IP rate limit, registered before the route plugins so it
// covers every endpoint (browsing, covers, range-request streaming). The ceiling
// is deliberately generous — high enough that a household never hits it under
// normal use, low enough to bound scripted abuse. Keys on request.ip, which
// honours the trustProxy setting above. Routes may tighten this individually.
await app.register(rateLimit, {
  max: 1000,
  timeWindow: "1 minute"
});
// Generic file uploads. No global fileSize cap — each upload route enforces its
// own size/extension policy while streaming (see core/uploads.ts). One file per
// request; small text fields only (the file streams to disk, never to memory).
await app.register(multipart, { limits: { files: 1, fields: 10, fieldSize: 100 * 1024 } });
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
