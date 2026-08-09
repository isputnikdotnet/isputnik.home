import { constants as zlibConstants } from "node:zlib";
import fastify from "fastify";
import compress from "@fastify/compress";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import helmet from "@fastify/helmet";
import staticFiles from "@fastify/static";
import { config } from "./config.js";
import { registerAuthDecorators } from "./auth.js";
import { isIpBlocked, isTrustedIp, hasForwardedHeader, getTrustProxyHops, noteForwardedHeader, forwardedProto, safeRedirectHost } from "./core/security.js";
import { flagAbusiveRequest } from "./core/security-alerts.js";
import { isProbePath } from "./core/probes.js";
import { registerCsrf } from "./core/csrf.js";
import { corePlugin } from "./core/index.js";
import { usersPlugin } from "./modules/users/index.js";
import { backupsPlugin } from "./modules/backups/index.js";
import { libraryPlugin } from "./modules/library/index.js";
import { collectionsPlugin } from "./modules/collections/index.js";
import { familyTreePlugin } from "./modules/familytree/index.js";
import { maintenancePlugin } from "./modules/maintenance/index.js";

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
  // HSTS is sent only when APP_URL says the app is reached over HTTPS (see
  // config.hsts), so the default http LAN deployment can't pin itself to a
  // scheme it doesn't serve. Subdomains are deliberately excluded: the same
  // domain often carries plain-http LAN hostnames, and preload is a one-way
  // door — an operator who wants either sets them at their proxy.
  hsts: config.hsts ? { maxAge: 31536000, includeSubDomains: false, preload: false } : false,
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      // Two families of external <img> are allowed, nothing else:
      //  - OSM raster tiles for the gallery map (Leaflet loads them as <img>); both
      //    the subdomain-less host and the a/b/c.tile.* mirrors are covered.
      //  - Metadata-provider cover thumbnails shown transiently in the Edit Metadata
      //    search (iTunes, Audible, Open Library, FantLab, LibriVox/archive.org).
      //    These load directly in the browser — never proxied through the server,
      //    which on an IPv4-only host could pin to an unreachable AAAA record and
      //    crash the process (ENETUNREACH). Applied covers are still stored locally,
      //    so this only affects the live search preview.
      imgSrc: [
        "'self'", "data:", "blob:",
        "https://tile.openstreetmap.org", "https://*.tile.openstreetmap.org",
        "https://*.mzstatic.com", "https://m.media-amazon.com",
        "https://covers.openlibrary.org", "https://fantlab.ru", "https://archive.org"
      ],
      mediaSrc: ["'self'", "blob:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      workerSrc: ["'self'", "blob:"],
      frameSrc: ["'self'", "blob:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"],
      // The app posts nowhere but itself. Pinning this means injected markup can't
      // point a form at an attacker's host — the classic way a content injection
      // turns into a credential-harvesting page that still looks like this site.
      formAction: ["'self'"]
    }
  }
});
await app.register(cookie);
// Compress JSON/text responses. The catalog, status and About payloads are the
// large ones — /api/about alone is a few hundred KB of changelog — and over a
// LAN or a phone on mobile data that is the difference between instant and not.
//
// Three deliberate settings:
//  - Only compressible types (mime-db's `compressible` flag, the plugin default)
//    are touched, so already-compressed bytes — covers, thumbnails, audio, video,
//    zip backups — pass through untouched rather than burning CPU for nothing.
//    The streaming routes hijack the reply anyway (reply.hijack + pipe to raw),
//    which bypasses onSend hooks entirely, so they never reach this plugin.
//  - Brotli at quality 4 rather than zlib's default 11. Eleven is tuned for
//    compress-once static assets; on a per-request payload it costs far more CPU
//    than it saves bytes, and this server shares a box with ffmpeg and face
//    inference. Four is about gzip's speed with a better ratio.
//  - A 1 KB floor: below that the framing overhead outweighs the saving.
//
// No BREACH exposure: the CSRF token is carried in a cookie (a header, which is
// not compressed), never reflected in a response body.
await app.register(compress, {
  global: true,
  threshold: 1024,
  encodings: ["br", "gzip", "deflate"],
  brotliOptions: { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } }
});
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
  // Nothing this server returns should ever be indexed — not the app, and above all
  // not a guest share link, which is unlisted by design and would otherwise outlive
  // its own revocation in someone's search index. robots.txt asks; this tells, and
  // it covers every response, not just the ones a crawler reaches through the SPA.
  reply.header("X-Robots-Tag", "noindex, nofollow");
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
    return;
  }
  // Send plain-http visitors to https. TLS terminates at the proxy, so every
  // request reaches this process over http and X-Forwarded-Proto is the only
  // evidence of how the visitor actually arrived. Three deliberate limits:
  //  - Only when the header explicitly says "http". Absent means no proxy is
  //    reporting a scheme, and redirecting then would loop forever on a setup
  //    that terminates TLS without setting the header.
  //  - Only when APP_URL says this is an https deployment, so the default LAN
  //    install can't redirect itself somewhere it doesn't answer.
  //  - 307, not 301: a permanent redirect is cached hard, and a deployment that
  //    later drops back to http would be stranded in browsers that remember it.
  //    It also preserves the method, so a POST isn't silently turned into a GET.
  // This is a backstop, not the primary control — a proxy that redirects at the
  // edge spares the origin the round trip entirely (HTTPS_REDIRECT=false there).
  if (config.httpsRedirect && forwardedProto(request.headers) === "http") {
    const host = safeRedirectHost(request.headers.host);
    if (host) {
      await reply.code(307).redirect(`https://${host}${request.url}`);
      return;
    }
  }
  // Scanner sweeps for software this app doesn't run. Answer 404 immediately —
  // ahead of CSRF, auth, and the SPA fallback that would otherwise return the
  // whole app shell — and count the hit, so a sweep blocks itself.
  if (isProbePath(request.url)) {
    flagAbusiveRequest(request);
    await reply.code(404).send({ error: "Not found" });
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
await app.register(familyTreePlugin);
await app.register(maintenancePlugin);

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
