# Hosting: reverse-proxy trust

How the server decides whether to believe `X-Forwarded-For`, and therefore what
`request.ip` means. Everything keyed on the client address — per-IP rate
limiting, auto-block, trusted zones, the outside-MFA policy, device linking,
the activity log — depends on getting this right. The user-facing walkthrough
is [docs/users/exposing-to-the-internet.md](users/exposing-to-the-internet.md);
this page is the reference for the two settings and their semantics.

## The default: trust nothing

With neither variable set, `request.ip` is the raw socket address and any
`X-Forwarded-For` header is ignored. Correct for a direct LAN install, and safe
by construction: a client cannot forge its own address. Behind a proxy it is
*wrong* — every visitor appears as the proxy's address — so the security checks
that would degrade dangerously (trusted-zone exemptions, the outside-MFA skip,
device linking) fail closed when they see a forwarding header in that state,
and the server logs a warning on the first such request.

## `TRUST_PROXY` — proxy addresses (preferred)

A comma-separated list of the proxy's own IPs and CIDR ranges:

```
TRUST_PROXY=172.18.0.0/16
TRUST_PROXY=10.0.0.5, fd00::1
```

`X-Forwarded-For` is walked right-to-left and believed only while the peer that
forwarded it is itself on the list; `request.ip` is the first address that
isn't. The grammar is the same as trusted zones (`core/cidr.ts`): IPv4, IPv6,
and a bare address as a single-host range. IPv4 peers reported by a dual-stack
socket as `::ffff:…` match their IPv4 range.

This form validates the **immediate peer**: even if the app is directly
reachable, a client connecting from an address not on the list gets its forged
header ignored. Entries that don't parse are dropped with a startup warning; a
`TRUST_PROXY` with no valid entries counts as unset.

## `TRUST_PROXY_HOPS` — hop count (backward compatible)

The number of reverse proxies in front (usually `1`). Trusts the first N
forwarding hops *whoever they are* — the pre-Fastify-5.12.1 numeric semantics,
applied via a trust function because Fastify 5.12.1 silently treats a numeric
`trustProxy` as "trust nothing" (hop-count trust cannot validate the immediate
peer, which is why it was dropped upstream).

Because any directly-connecting client counts as "the first hop", this form is
only safe when the app is **not reachable except through the proxy** (port
bound to localhost or an internal Docker network). Prefer `TRUST_PROXY` when
you know the proxy's address; keep `TRUST_PROXY_HOPS` for a proxy whose
address changes, or an existing deployment you don't want to touch.

## Precedence and plumbing

When both are set, `TRUST_PROXY` wins — it is the stricter check. The
resolution lives in `resolveProxyTrust()` in
[apps/server/src/core/security.ts](../apps/server/src/core/security.ts), which
[apps/server/src/index.ts](../apps/server/src/index.ts) hands to Fastify's
`trustProxy` option once at startup. `isProxyTrustConfigured()` is the live
"either form is on" predicate the fail-closed checks use, and
`getTrustProxyHops()` / `getTrustProxyCidrs()` are read live for the admin
security UI (Control panel → Security). Tests:
[apps/server/test/trust-proxy.test.ts](../apps/server/test/trust-proxy.test.ts).
