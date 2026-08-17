// Known vulnerability-scanner probe paths. An internet-exposed host is swept
// constantly for other people's software — WordPress, phpMyAdmin, leaked .env and
// .git directories. None of it exists here, but with the SPA fallback every one of
// those probes gets a 200 and the whole app shell, which is both wasted bandwidth
// and a free ride: nothing about the request ever counts against the source.
//
// Matching one of these is not a mistake a real client can make, so a hit is
// treated as abuse — answered with a bare 404 and counted toward the per-IP
// auto-block (see flagAbusiveRequest), which turns a sweep into a self-blocking
// action. That makes false positives the only real risk, so the patterns stay
// narrow and specific: anything a browser, an e-reader, or a PWA might legitimately
// request must never appear here. Notably absent is /.well-known/ (ACME renewals
// and app-association files live there).

const PROBE_PATTERNS: RegExp[] = [
  // No PHP is served by this app under any path, so any .php request is a probe.
  /\.php(?:[/?]|$)/,
  // Secrets and VCS metadata left in a web root. Covers .env, .env.local, .env.bak.
  /^\/\.env/,
  /^\/\.(?:git|svn|hg|aws|ssh|docker|vscode)(?:\/|$)/,
  /^\/wp-(?:admin|login|content|includes|json)/,
  /^\/(?:phpmyadmin|pma|myadmin|adminer)(?:\/|$)/,
  /^\/cgi-bin\//,
  /^\/vendor\//,
  /^\/(?:actuator|solr|jenkins|struts|jmx-console|server-status|server-info|nginx_status)(?:\/|$)/,
  // GraphQL endpoints, versioned or not. This app has none, and a browser never
  // asks for one on its own; the trailing boundary keeps /graphql-tutorial clean.
  /^\/(?:v\d+\/)?graphql(?:\/|$)/,
  // Database dumps, editor leftovers, and secret material (keys, certs, YAML
  // config) left in a web root. Nothing this app serves uses these extensions.
  /^\/[^?]*\.(?:sql|bak|swp|key|pem|yml|yaml)$/,
  // Credential JSON by exact name only — a broad .json rule would catch
  // /manifest.json, which PWAs legitimately request.
  /^\/(?:auth|credentials|secrets)\.json$/
];

// The API and OPDS trees authenticate their own callers and speak JSON/XML; a
// miss inside them is an unknown endpoint, never a page, so neither the probe
// patterns nor the SPA fallback apply there.
export function isApiSurface(url: string): boolean {
  const pathname = (url.split("?")[0] || "/").toLowerCase();
  return pathname.startsWith("/api/") || pathname === "/opds" || pathname.startsWith("/opds/");
}

// True when the URL can only be a scan. The API and OPDS trees are excluded: they
// report their own failures, and their paths carry opaque ids that shouldn't be
// pattern-matched.
export function isProbePath(url: string): boolean {
  const pathname = (url.split("?")[0] || "/").toLowerCase();
  if (isApiSurface(pathname)) return false;
  return PROBE_PATTERNS.some((pattern) => pattern.test(pathname));
}
