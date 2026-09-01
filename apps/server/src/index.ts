import fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import helmet from "@fastify/helmet";
import staticFiles from "@fastify/static";
import { config } from "./config.js";
import { registerAuthDecorators } from "./auth.js";
import { isIpBlocked, isTrustedIp, isTrustedRequest, hasForwardedHeader, resolveProxyTrust, parseTrustProxyList, noteForwardedHeader, forwardedProto, safeRedirectHost, deletionBlocked } from "./core/security.js";
import { flagAbusiveRequest } from "./core/security-alerts.js";
import { isApiSurface, isProbePath } from "./core/probes.js";
import { maskLogUrl } from "./core/log-redaction.js";
import { BLOCKED_MESSAGE, BLOCKED_PAGE_HTML, wantsHtml } from "./core/blocked-page.js";
import { registerCsrf } from "./core/csrf.js";
import { registerCompression } from "./core/compression.js";
import { corePlugin } from "./core/index.js";
import { usersPlugin } from "./modules/users/index.js";
import { backupsPlugin } from "./modules/backups/index.js";
import { libraryPlugin } from "./modules/library/index.js";
import { collectionsPlugin } from "./modules/collections/index.js";
import { storiesPlugin } from "./modules/stories/index.js";
import { socialPlugin } from "./modules/social/index.js";
import { homePlugin } from "./modules/home/index.js";
import { familyTreePlugin } from "./modules/familytree/index.js";
import { maintenancePlugin } from "./modules/maintenance/index.js";

// X-Forwarded-For is only trusted when the operator names the reverse proxies in
// front — TRUST_PROXY with the proxy's own IPs/CIDRs (preferred: the header is
// believed only while the peer that sent it is itself on the list), or the older
// TRUST_PROXY_HOPS with a hop count (kept for compatibility; addresses win when
// both are set). Left unset we trust nothing and use the raw socket IP, so a
// direct client can't forge its address — which would otherwise poison audit logs
// and hand out fresh rate-limit buckets. See docs/hosting.md.
const proxyTrust = resolveProxyTrust();
const trustProxyConfigured = proxyTrust !== false;
let proxyMisconfigWarned = false;

const app = fastify({
  logger: {
    serializers: {
      // Mirror Fastify's default request log, but mask every path-segment token
      // (OPDS feed, guest share, invite) so the token-in-URL convenience never
      // leaks a live credential into the logs. See core/log-redaction.ts.
      req(request) {
        const version = request.headers?.["accept-version"];
        return {
          method: request.method,
          url: maskLogUrl(request.url),
          version: Array.isArray(version) ? version[0] : version,
          hostname: request.hostname,
          remoteAddress: request.ip,
          remotePort: request.socket?.remotePort
        };
      }
    }
  },
  // Fastify 5.12.1 removed numeric trustProxy (a hop count is now silently
  // treated as "trust nothing"), so both settings are applied as a trust
  // function (see resolveProxyTrust): TRUST_PROXY matches each forwarding peer
  // against the configured addresses, TRUST_PROXY_HOPS keeps the pre-5.12.1
  // semantics of trusting the first N hops. Hop-count trust can't validate the
  // immediate peer — the existing rule stands that the app must not be reachable
  // except through the proxy when hops are set; address trust closes that hole.
  trustProxy: proxyTrust
});

// An unparseable TRUST_PROXY entry is dropped rather than trusted-by-accident;
// say so at startup, because a typo here otherwise surfaces only as "the client
// IPs are wrong" much later. If every entry was invalid, proxy trust falls back
// to TRUST_PROXY_HOPS or (if that is unset too) to trusting nothing.
{
  const { invalid } = parseTrustProxyList();
  if (invalid.length > 0) {
    app.log.warn(
      `Ignoring ${invalid.length === 1 ? "an invalid TRUST_PROXY entry" : "invalid TRUST_PROXY entries"}: ${invalid.join(", ")} — each entry must be an IP address or CIDR range (e.g. "172.18.0.0/16").`
    );
  }
}

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
      //  - Person portraits shown the same transient way in the author/narrator
      //    "Find info" picker: Wikipedia serves those from Commons, and FantLab
      //    from the host already listed for its covers.
      imgSrc: [
        "'self'", "data:", "blob:",
        "https://tile.openstreetmap.org", "https://*.tile.openstreetmap.org",
        "https://*.mzstatic.com", "https://m.media-amazon.com",
        "https://covers.openlibrary.org", "https://fantlab.ru", "https://archive.org",
        "https://upload.wikimedia.org"
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
// Compress JSON and text responses. Synchronous, and hand-rolled rather than
// @fastify/compress, for a reason worth reading before changing it — see the
// comment at the top of core/compression.ts.
//
// No BREACH exposure: the CSRF token is carried in a cookie (a header, which is
// not compressed), never reflected in a response body.
registerCompression(app);
// Global per-client-IP rate limit, registered before the route plugins so it
// covers every endpoint (browsing, covers, range-request streaming). The ceiling
// is deliberately generous — high enough that a household never hits it under
// normal use, low enough to bound scripted abuse. Keys on request.ip, which
// honours the trustProxy setting above. Routes may tighten this individually.
await app.register(rateLimit, {
  max: 1000,
  timeWindow: "1 minute",
  // Trusted networks (admin-configured) are exempt from rate limiting — but not
  // when a misconfigured proxy makes request.ip the proxy's own address, or the
  // whole internet would share the exemption (see isTrustedRequest).
  allowList: (request) => isTrustedRequest(request)
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
  // With proxy trust unconfigured, request.ip is then the proxy — silently breaking
  // the per-IP controls (and letting everyone match a trusted network). Warn once.
  if (hasForwardedHeader(request.headers)) {
    noteForwardedHeader();
    if (!trustProxyConfigured && !proxyMisconfigWarned) {
      proxyMisconfigWarned = true;
      request.log.warn(
        "Detected an X-Forwarded-For header but proxy trust is unconfigured — request.ip is the proxy's address, not the client's. This breaks per-IP rate limiting and auto-block, and can let every client match a trusted network (bypassing MFA). Set TRUST_PROXY to your proxy's IP or CIDR (preferred), or TRUST_PROXY_HOPS to the number of proxies in front (usually 1). See docs/users/exposing-to-the-internet.md."
      );
    }
  }
  if (isIpBlocked(request.ip) && !isTrustedIp(request.ip)) {
    // A navigating browser gets a small page; API callers get JSON they can show.
    if (wantsHtml(request.headers)) {
      await reply.code(403).type("text/html; charset=utf-8").send(BLOCKED_PAGE_HTML);
    } else {
      await reply.code(403).send({ error: BLOCKED_MESSAGE });
    }
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
    flagAbusiveRequest(request, "probe");
    await reply.code(404).send({ error: "Not found" });
  }
});
// The route-config keys the deletion-protection hook below reads. Declared once
// here; the routes that carry them are annotated where they are defined.
declare module "fastify" {
  interface FastifyContextConfig {
    // Exempt a DELETE route: revoking sessions/tokens protects the account
    // rather than destroying content, and a travelling user needs it.
    untrustedAllow?: boolean;
    // Mark a non-DELETE route that permanently destroys data (Recycle Bin
    // empty, duplicate-cleanup deletions, backup restore).
    destructive?: boolean;
  }
}
// Deletion protection (opt-in policy, Security → Policies): refuse destructive
// actions arriving from outside a trusted network — every account, admins
// included, so stolen credentials used from the internet can't destroy content.
// Runs after routing, so the matched route's config is available.
app.addHook("onRequest", async (request, reply) => {
  if (deletionBlocked(request, request.routeOptions?.config)) {
    await reply.code(403).send({ error: "Deleting is disabled outside trusted networks." });
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
await app.register(storiesPlugin);
await app.register(socialPlugin);
await app.register(homePlugin);
await app.register(familyTreePlugin);
await app.register(maintenancePlugin);

if (config.staticPath) {
  await app.register(staticFiles, {
    root: config.staticPath,
    wildcard: false
  });
  app.setNotFoundHandler((request, reply) => {
    // An unknown API or OPDS path is a missing endpoint, not a page: answer a
    // proper 404 instead of the app shell (scanners probing /api/… were getting
    // 200 + index.html). Deliberately NOT abuse-flagged — a PWA running stale
    // JS after an upgrade, or an e-reader holding an old OPDS URL, lands here
    // legitimately.
    if (isApiSurface(request.url)) {
      return reply.code(404).send({ error: "Not found" });
    }
    return reply.sendFile("index.html");
  });
}

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  reply.code(500).send({ error: "Unexpected server error" });
});

await app.listen({ host: config.host, port: config.port });

// Last-resort guards, installed only once the server is listening — a failure
// to boot must still crash the process (so the container restarts and the log
// ends at the real error) rather than leave a half-initialized zombie; note a
// top-level await failure above surfaces as an unhandledRejection, which is why
// these cannot be registered earlier. After startup the calculus flips: the one
// real crash so far was a GC-time landmine — exifr leaked a FileHandle on a
// malformed photo, and Node 24+ makes collecting an unclosed handle a fatal
// error, detonating minutes after the swallowed parse error with no request in
// sight. Synchronous state stays consistent (better-sqlite3 commits or throws
// in place) and request errors have Fastify's handler above, so log the stack
// loudly and keep serving instead of taking the library down over one bad file.
process.on("uncaughtException", (error, origin) => {
  app.log.error({ err: error, origin }, "Uncaught exception — server continuing");
});
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  app.log.error({ err }, "Unhandled promise rejection — server continuing");
});
