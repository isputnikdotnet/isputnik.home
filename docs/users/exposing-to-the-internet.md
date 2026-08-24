# Exposing your library to the internet

By default isputnik.home is meant for your **home network** and ships configured
for plain HTTP. Before you open it to the internet, put it behind HTTPS and turn
on a few settings. This guide is for whoever runs the server.

> Do all of this **before** sharing the address. In particular, finish the
> first-run admin setup while you're still on your home network — until the first
> account exists, anyone who can reach the app can claim the admin account.

## 1. Put a reverse proxy with HTTPS in front

Don't expose the app's port (`4000`) to the internet directly — it speaks plain
HTTP, so your session cookies would travel unencrypted. Instead run a reverse
proxy that terminates TLS (handles the HTTPS certificate) and forwards to the app.
Common choices:

- **Caddy** — automatic HTTPS certificates, simplest to start with
- **Nginx Proxy Manager** — popular on Unraid, point-and-click
- **Traefik**, **nginx**, or a **Cloudflare Tunnel** — all fine

Keep the container's port bound to the host only (for example
`127.0.0.1:4000:4000`, or an internal Docker network shared with the proxy) so the
proxy is the only way in.

## 2. Set these environment variables

| Variable | Set to | Why |
|---|---|---|
| `APP_URL` | `https://your-domain` | Your public address; used for links and CORS |
| `COOKIE_SECURE` | `true` (or `auto`) | Send the session cookie only over HTTPS |
| `TRUST_PROXY` | your proxy's IP or CIDR (e.g. `172.18.0.0/16`) | So rate limits and logs see the real visitor, not the proxy |

`COOKIE_SECURE=auto` follows `APP_URL` instead of stating it twice — secure
cookies on for an `https://` address, off for a plain-http home install. Set
`true` or `false` only to override that.

Setting `APP_URL` to an `https://` address also turns on two HTTPS protections:
**HSTS** (browsers are told to only ever reach your domain over HTTPS) and an
**http → https redirect** for visitors who arrive without it. Neither does anything
on a plain-http `APP_URL`, so a home install is unaffected. Set `HSTS=false` or
`HTTPS_REDIRECT=false` if your reverse proxy already handles that one itself.

Prefer doing the redirect at the proxy when it offers it (Cloudflare's "Always Use
HTTPS", Caddy's automatic redirect, an nginx `return 301`): the request is then
turned around at the edge and never reaches the app at all. The app's own redirect
is a backstop for proxies that don't, and it depends on the proxy sending an
`X-Forwarded-Proto` header — without one, the app cannot tell how the visitor
arrived and deliberately does nothing rather than risk a redirect loop.

### About `TRUST_PROXY` (and `TRUST_PROXY_HOPS`)

The app needs the real visitor's IP address for rate limiting and the activity
log. Behind a proxy, that arrives in an `X-Forwarded-For` header. By default the
app **trusts nothing** and uses the direct connection's address — correct when
there's no proxy, but it will show the proxy's address once you add one.

Set `TRUST_PROXY` to the proxy's own address — a single IP, a CIDR range, or a
comma-separated list of both (for example `TRUST_PROXY=172.18.0.0/16` for a
Docker network, or the CDN's published ranges when one sits in front). The
forwarded header is then believed only when it actually comes from your proxy,
so a visitor who somehow reaches the app directly still can't forge their
address.

The older `TRUST_PROXY_HOPS` still works: set it to the number of proxies
between the internet and the app (one reverse proxy = `1`; a CDN in front of
that = `2`). It trusts that many hops *whoever they are*, so it only holds if
port `4000` isn't reachable directly (step 1) — and setting it **higher** than
the real number would let a visitor forge their address. Prefer `TRUST_PROXY`
when you know the proxy's address; if both are set, `TRUST_PROXY` wins.

## 3. Strongly recommended

- **Turn on two-factor authentication** for admin accounts, and encourage everyone
  to use it — see [Two-factor authentication](two-factor-authentication.md).
- **Require a second factor from outside** (Control panel → **Security** →
  **Policies** → **Two-factor sign-in**). Everything else on this page defends
  against guessing; this is the one that still holds when someone shows up with a
  *correct* password. Accounts without two-factor set up fall back to a code
  emailed at sign-in, so configure email first.
- **Tell everyone about passkeys** ([guide](passkeys.md)). Once the steps above are
  done they switch on by themselves: passkeys need exactly this setup — HTTPS at a
  real hostname — and they're both quicker and harder to phish than a password.
- **Set up email** ([guide](email.md)) so the server can tell you about locked
  accounts, blocked addresses, and sign-ins from networks it hasn't seen. On an
  internet-facing install this is how you find out something is being tried.
- **Use strong, unique passwords.**
- **Keep the app updated.**

## About the container user

The app runs **unprivileged** — the server process never runs as root, so a flaw
in the code that parses uploads (images, e-books, video) can't turn into root
access to your media. It runs as `PUID:PGID`, defaulting to `1000:1000`
(`99:100` on the Unraid template, matching a default appdata share). On first
start it takes ownership of the `/config` volume as that user.

If the app can't write to `/config` after an update, the volume is owned by a
different user: set `PUID`/`PGID` to match its owner (`ls -n` on the host shows
the numbers), or `chown -R` the folder to `1000:1000`. Keep media mounts
read-only (`:ro`) unless you upload through the app.

## Checklist

```
[ ] Reverse proxy with a valid HTTPS certificate in front
[ ] App port not published to the internet directly
[ ] APP_URL = https://your-domain
[ ] COOKIE_SECURE = true
[ ] TRUST_PROXY = the proxy's IP/CIDR (or TRUST_PROXY_HOPS = number of proxies)
[ ] First-run admin setup completed on the home network
[ ] Two-factor enabled for admin accounts
[ ] Email configured, so security alerts actually reach you
```

## When sign-in fails on someone else's network

Office, school, hotel and airport networks often run a security gateway (Zscaler,
Umbrella, a web filter, a guest Wi-Fi portal) that inspects every request. A brand
new domain is usually filed as *uncategorised*, and some gateways block those
outright — they answer the browser themselves with a **403 caution page** instead
of passing the request to your server.

That failure is confusing on purpose-built sites: the page itself often loads (from
the browser cache or a CDN), and only the calls to `/api/…` are refused, so it looks
like the app is broken or the password is wrong. iSputnik detects it now — a gateway
status (403, 407, 451, 511) carrying a web page rather than the JSON the server
always sends — and says **"Blocked by your network"** on the sign-in screen and in
the status pill, instead of blaming the sign-in.

If you see it:

- Try the same address on a phone using mobile data. If it works there, the gateway
  is the problem, not your server.
- Ask whoever runs that network to allow your domain, or submit it for
  recategorisation with the gateway vendor (Zscaler, Cisco Umbrella and the rest all
  have a public "site review" form; most reclassify within a day or two).
- A VPN back to your home network also sidesteps it, since the gateway then only
  sees the VPN connection.

There is nothing to change on the server — the request never reaches it.

## Note for maintainers

Security headers are sent by `@fastify/helmet` (see `apps/server/src/index.ts`).
The Content-Security-Policy is **enforced**, not report-only: it was validated
against the reader, cover images, the gallery map, and the installable PWA first.
Anything new that loads an external resource has to be added to the policy or the
browser will block it.

HSTS follows `APP_URL`: it's sent (one year, no `includeSubDomains`, no preload)
when `APP_URL` starts with `https://`, and omitted otherwise, so the default
plain-HTTP LAN deployment can't pin a browser to a scheme it doesn't serve. Set
`HSTS=false` to suppress it when the reverse proxy already sends its own.
`includeSubDomains` and `preload` are intentionally left to the proxy — both
affect hostnames this app knows nothing about, and preload can't be undone quickly.
