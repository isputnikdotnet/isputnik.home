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
| `COOKIE_SECURE` | `true` | Send the session cookie only over HTTPS |
| `TRUST_PROXY_HOPS` | number of proxies in front (usually `1`) | So rate limits and logs see the real visitor, not the proxy |

### About `TRUST_PROXY_HOPS`

The app needs the real visitor's IP address for rate limiting and the activity
log. Behind a proxy, that arrives in an `X-Forwarded-For` header. By default the
app **trusts nothing** and uses the direct connection's address — correct when
there's no proxy, but it will show the proxy's address once you add one.

Set `TRUST_PROXY_HOPS` to the number of proxies between the internet and the app
(one reverse proxy = `1`; a CDN in front of that = `2`). Setting it **higher** than
the real number would let a visitor forge their address, so match it exactly — and
make sure port `4000` isn't reachable directly (step 1) so the proxy is always the
one adding the header.

## 3. Strongly recommended

- **Turn on two-factor authentication** for admin accounts, and encourage everyone
  to use it — see [two-factor-authentication.md](two-factor-authentication.md).
- **Use strong, unique passwords.**
- **Keep the app updated.**

## Checklist

```
[ ] Reverse proxy with a valid HTTPS certificate in front
[ ] App port not published to the internet directly
[ ] APP_URL = https://your-domain
[ ] COOKIE_SECURE = true
[ ] TRUST_PROXY_HOPS = number of proxies (usually 1)
[ ] First-run admin setup completed on the home network
[ ] Two-factor enabled for admin accounts
```

## Note for maintainers

Security headers are sent by `@fastify/helmet`. The Content-Security-Policy
currently ships in **report-only** mode — it reports violations to the browser
console but doesn't block them — so the policy can be validated against the reader,
cover images, and the installable PWA before it's enforced. Flip `reportOnly`
to `false` in `apps/server/src/index.ts` once that pass is done. HSTS is left off
until HTTPS is confirmed working, then enabled via helmet's `hsts` option.
