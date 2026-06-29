import fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import helmet from "@fastify/helmet";
import staticFiles from "@fastify/static";
import { config } from "./config.js";
import { registerAuthDecorators } from "./auth.js";
import { isIpBlocked, isTrustedIp, hasForwardedHeader, getTrustProxyHops, noteForwardedHeader } from "./core/security.js";
import { registerCsrf } from "./core/csrf.js";
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
const trustProxyHops = getTrustProxyHops();
const trustProxyConfigured = trustProxyHops > 0;
let proxyMisconfigWarned = false;

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
  trustProxy: trustProxyConfigured ? trustProxyHops : false
});

await app.register(cors, {
  origin: config.appUrl,
  credentials: true
});
// Security headers. The CSP is tailored to exactly what the app loads: same-origin
// scripts and styles (the build has no inline scripts; styles allow inline), cover
// and reader content from blob:/data:, audio from blob:, and the foliate reader's
// blob iframe. Verified against the production bundle (no eval/WASM, workers
// disabled) before switching from report-only to enforcing. The single external
// resource is the gallery map: Leaflet fetches OpenStreetMap raster tiles as
// <img>, so imgSrc allows the OSM tile hosts (and nothing else does).
await app.register(helmet, {
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: "no-referrer" },
  // HSTS belongs to the TLS-terminating proxy and stays off here until HTTPS is
  // confirmed, so a mis-set max-age can't strand the http LAN deployment.
  hsts: false,
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      // OSM raster tiles for the gallery map (Leaflet loads them as <img>). Both the
      // subdomain-less host and the a/b/c.tile.* mirrors are covered.
      imgSrc: ["'self'", "data:", "blob:", "https://tile.openstreetmap.org", "https://*.tile.openstreetmap.org"],
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
  timeWindow: "1 minute",
  // Trusted networks (admin-configured) are exempt from rate limiting.
  allowList: (request) => isTrustedIp(request.ip)
});
// Reject blocked source IPs everywhere — manual or auto-blocked — but never a
// trusted network. isIpBlocked is the cheap, usually-false common-case check.
app.addHook("onRequest", async (request, reply) => {
  // Note any proxy forwarding header so the admin UI can show "a proxy is in front".
  // With TRUST_PROXY_HOPS unset, request.ip is then the proxy — silently breaking the
  // per-IP controls (and letting everyone match a trusted network). Warn once.
  if (hasForwardedHeader(request.headers)) {
    noteForwardedHeader();
    if (!trustProxyConfigured && !proxyMisconfigWarned) {
      proxyMisconfigWarned = true;
      request.log.warn(
        "Detected an X-Forwarded-For header but TRUST_PROXY_HOPS is unset — request.ip is the proxy's address, not the client's. This breaks per-IP rate limiting and auto-block, and can let every client match a trusted network (bypassing MFA). Set TRUST_PROXY_HOPS to the number of proxies in front (usually 1). See docs/users/exposing-to-the-internet.md."
      );
    }
  }
  if (isIpBlocked(request.ip) && !isTrustedIp(request.ip)) {
    await reply.code(403).send({ error: "Your network has been blocked." });
  }
});
// CSRF: a double-submit token validated on every state-changing request.
registerCsrf(app);
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
