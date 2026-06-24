import fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import helmet from "@fastify/helmet";
import staticFiles from "@fastify/static";
import { config } from "./config.js";
import { registerAuthDecorators } from "./auth.js";
import { corePlugin } from "./core/index.js";
import { usersPlugin } from "./modules/users/index.js";
import { backupsPlugin } from "./modules/backups/index.js";
import { libraryPlugin } from "./modules/library/index.js";
import { collectionsPlugin } from "./modules/collections/index.js";

// X-Forwarded-For is only trusted when TRUST_PROXY_HOPS names how many reverse
// proxies sit in front (e.g. 1 for a single nginx/Caddy/NPM). Left unset we trust
// nothing and use the raw socket IP, so a direct client can't forge its address —
// which would otherwise poison audit logs and hand out fresh rate-limit buckets.
// Operators exposing the app set this to match their proxy chain (see docs/hosting.md).
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS);

const app = fastify({
  logger: {
    serializers: {
      // Mirror Fastify's default request log, but mask the OPDS path token so the
      // token-in-URL convenience never leaks a live credential into the logs.
      req(request) {
        const version = request.headers?.["accept-version"];
        return {
          method: request.method,
          url: request.url.replace(/(\/opds\/)isp_[^/?]+/g, "$1<token>"),
          version: Array.isArray(version) ? version[0] : version,
          hostname: request.hostname,
          remoteAddress: request.ip,
          remotePort: request.socket?.remotePort
        };
      }
    }
  },
  trustProxy: Number.isInteger(trustProxyHops) && trustProxyHops > 0 ? trustProxyHops : false
});

await app.register(cors, {
  origin: config.appUrl,
  credentials: true
});
// Security headers. The CSP ships in report-only mode first: the PWA serves covers
// and EPUB content from blob:/data: URLs and the foliate reader spawns workers and
// iframes, so the policy needs real-world verification before it's enforced — until
// then a mismatch is reported to the browser console instead of breaking the page.
// The remaining headers (no-sniff, frame-ancestors, referrer policy) are enforced now.
await app.register(helmet, {
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: "no-referrer" },
  // HSTS belongs to the TLS-terminating proxy and stays off here until HTTPS is
  // confirmed, so a mis-set max-age can't strand the http LAN deployment.
  hsts: false,
  contentSecurityPolicy: {
    useDefaults: false,
    reportOnly: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      mediaSrc: ["'self'", "blob:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      workerSrc: ["'self'", "blob:"],
      frameSrc: ["'self'", "blob:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"]
    }
  }
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
// own size/extension policy while streaming (see modules/uploads). One file per
// request; small text fields only (the file streams to disk, never to memory).
await app.register(multipart, { limits: { files: 1, fields: 10, fieldSize: 100 * 1024 } });
await registerAuthDecorators(app);
await app.register(corePlugin);
await app.register(usersPlugin);
await app.register(backupsPlugin);
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
