// Some routes carry a bearer credential as a path segment: the OPDS feed token
// (/opds/<token>), guest share links (/api/share/<token>/…), and invite links
// (/api/invites/<token>). Logging those URLs verbatim would defeat the
// store-only-a-hash design — a pasted support log or a shipped log stream would
// hand out live feeds, live share links, and unused invites (an invite grants
// account creation). The request-log serializer runs every URL through here
// first. Each pattern keeps the route prefix and replaces only the token
// segment, so the path stays legible ("/api/share/<token>/download") while the
// credential never lands in a log. The share matcher is anchored to the singular
// "/api/share/" guest prefix, so the owner's "/api/shares/…" routes are untouched.
const TOKEN_IN_PATH: RegExp[] = [
  /(\/opds\/)isp_[^/?]+/g,
  /(\/api\/share\/)[^/?]+/g,
  /(\/api\/invites\/)[^/?]+/g,
  // The browser-facing SPA routes that carry the same tokens — the MOST logged
  // occurrence, since every guest page load and every invite click hits them (the
  // SPA fallback serves index.html and the request is logged). Anchored to the
  // path start so they can't over-mask a deeper /share/ or /invite/ segment.
  /^(\/share\/)[^/?]+/g,
  /^(\/invite\/)[^/?]+/g
];

export function maskLogUrl(url: string): string {
  let masked = url;
  for (const pattern of TOKEN_IN_PATH) masked = masked.replace(pattern, "$1<token>");
  return masked;
}
