// A cookie pinned to this exact origin via the __Host- prefix: the browser only
// accepts it when it is Secure, Path=/ and carries no Domain, and it refuses to
// let a sibling subdomain overwrite it — closing "cookie tossing", where a
// neighbour on a shared parent domain plants a cookie of their choosing (a chosen
// session or challenge id) that the app would otherwise trust.
//
// The prefix REQUIRES Secure, so a plain-http LAN deployment (COOKIE_SECURE off)
// has to keep the bare name — naming it __Host- there makes the browser drop the
// cookie outright, and nothing could authenticate. This is the same rule the CSRF
// cookie already follows (core/csrf.ts); the session, MFA-challenge and passkey-
// ceremony cookies use it too. Callers must set the cookie with Secure/Path=/ and
// no Domain to match (they already do).
export function hostCookieName(base: string, secure: boolean): string {
  return secure ? `__Host-${base}` : base;
}
