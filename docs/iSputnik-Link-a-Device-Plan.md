# Link a Device — implementation plan

Companion to [`iSputnik-Link-a-Device-Proposal.md`](iSputnik-Link-a-Device-Proposal.md),
which holds the *what* and *why*. This is the *how*: ordered work packages, the
files each one touches, and what "done" means for it.

Target release: **3.5.0** (current is 3.4.3). Branch: `feat/link-a-device`.

Stages 1–4 are the server and are strictly ordered. Stages 5–8 are the web app and
can start as soon as stage 3 fixes the API shape. Stages 9–10 close it out.

---

## Stage 0 — Preflight

- Branch off `main`. The working tree currently carries uncommitted gallery work;
  land or stash that first — this feature touches `schema.sql` and `migrate.ts`,
  which are the two files a half-finished migration corrupts a dev database with
  (`tsx watch` restarts onto in-progress edits).
- Confirm the dev database's `user_version` is 36 before starting:
  `sqlite3 data/db/isputnik.sqlite "PRAGMA user_version"`.
- `npm test` green from the start, so nothing later is ambiguous.

---

## Stage 1 — Server foundations

Five small, independently testable changes. Nothing user-visible.

### 1a. `isPrivateIp()` — `core/cidr.ts`

```ts
export function isPrivateIp(ip: string): boolean
```

Built on the existing `ipInAnyCidr` over `10.0.0.0/8`, `172.16.0.0/12`,
`192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`, `::1/128`, `fc00::/7`,
`fe80::/10`. Also handle the IPv4-mapped `::ffff:192.168.1.5` form Node hands back
on a dual-stack socket — `ipNetworkKey` already meets this, so mirror whatever it
does rather than inventing a second normalisation.

Tests: extend `test/cidr.test.ts`.

### 1b. `deviceLinkScope` — `core/security.ts`

Add to `SecurityPolicy`:

```ts
deviceLinkScope: "local" | "any";   // DEFAULT_SECURITY_POLICY: "local"
```

`getSecurityPolicy()` already merges over the defaults, so existing installs adopt
`local` with no migration. Add the resolver the routes will call:

```ts
export type DeviceLinkVerdict = { allowed: true } | { allowed: false; reason: "scope" | "proxy" };
export function deviceLinkAllowedFrom(ip: string | null | undefined, headers: Record<string, unknown>): DeviceLinkVerdict
```

Allowed when scope is `any`, or when the IP is trusted (`isTrustedIp`) or private
(`isPrivateIp`). Refused with `reason: "scope"` for anything else and for a missing
IP; refused with `reason: "proxy"` — ahead of the scope check, so `any` cannot
paper over it — when the request carries a forwarded header while
`getTrustProxyHops()` is 0. In that state `request.ip` is the proxy and every
caller looks local.

> **Changed during implementation.** The plan originally read the process-wide
> `wasForwardedHeaderSeen()` latch and returned a bare boolean. The latch is both
> too broad and abusable: any client may send `X-Forwarded-For`, it never resets,
> so one curious device on the LAN could switch device linking off for the whole
> household until the next restart. Judging **this request's** headers via the
> existing `hasForwardedHeader()` is more accurate and can't be weaponised — a
> spoofed header only refuses its own request, which is the safe direction. The
> verdict became a discriminated union at the same time, so the route can pass the
> reason straight to `alertDeviceLinkRejected`.

`policySchema` in `core/security-routes.ts` needs the field too (a required
`z.enum(["local", "any"])`) or it can never be set — and the web's local
`SecurityPolicy` interface in `SecuritySection.tsx` needs it for the same reason,
since both policy cards PATCH the whole blob. The UI control itself is stage 8.

Tests: new `test/device-link-policy.test.ts` — the scope matrix, the
misconfigured-proxy refusal, and that an older policy blob with no opinion adopts
`local`.

### 1c. `sessions.kind` + `sessions.label` — `db/schema.sql`, `db/migrate.ts`

In `schema.sql`, on the `sessions` table:

```sql
kind   TEXT NOT NULL DEFAULT 'browser' CHECK (kind IN ('browser','device')),
label  TEXT,
```

New columns on an existing table, so a migration entry is required — **version 37**,
in the established shape (read `PRAGMA table_info`, `ALTER TABLE ADD COLUMN` only
what's missing). Do not rename or rebuild the table: a `RENAME` rewrites child FK
references even under `legacy_alter_table`.

### 1d. `issueSession` options — `auth.ts`

```ts
export function issueSession(
  reply: FastifyReply,
  userId: string,
  request: FastifyRequest,
  opts: { kind?: "browser" | "device"; label?: string | null; days?: number } = {}
): string    // now returns the session id, so the caller can record it
```

Defaults keep all five existing call sites (`auth-routes.ts:104`,
`mfa-routes.ts:567`, `setup.ts:95`, `webauthn-routes.ts:293`,
`modules/users/invites.ts:174`) behaving exactly as they do today — verify by
leaving them untouched and letting `npm run typecheck` prove it.

Add `deviceSessionDays: Number(process.env.DEVICE_SESSION_DAYS ?? 365)` to
`config.ts` next to `sessionDays`.

### 1e. Device sessions are not admin sessions — `auth.ts`

`app.authenticate` already re-reads the session row on every request; select
`sessions.kind` alongside the user and hang it on `request.sessionKind`. Then in
`requireAdmin`, ahead of the role check:

```ts
if (request.sessionKind === "device") {
  return reply.code(403).send({ error: "This device can't use admin features. Sign in on your own device." });
}
```

Tests: new `test/device-session-scope.test.ts` — an admin's device session is 403 on
an admin route and 200 on a normal one; a browser session is unaffected.

**Done when:** `npm test` and `npm run typecheck` pass, the dev DB reports
`user_version` 37, and no behaviour has changed for any existing flow.

> **Status: done.** `test/device-link-policy.test.ts` (13) and
> `test/device-session-scope.test.ts` (10) are green, `cidr.test.ts` covers
> `isPrivateIp`, and the full suite passes at 1116. The two hardcoded
> latest-schema-version assertions in `gallery-slideshow-render.test.ts` were
> bumped 36 → 37, which every migration has to do. The upgrade path was rehearsed
> against a database built on the pre-change schema and stamped at 36: `kind` and
> `label` land, live sessions survive as `browser`/no-label, `device_name` and
> `ip_address` are untouched, the CHECK rejects an unknown kind, and `migrate()`
> stays safe to re-run.

---

## Stage 2 — The device-link service

New file `core/device-link.ts` — pure functions over the new table, no Fastify.
Same service/routes split as `mfa.ts` / `webauthn.ts`, so the interesting logic is
unit-testable without a server.

Schema (full DDL in the proposal) goes into `schema.sql` as a new table — **no**
migration entry; `schema.sql` is idempotent and applied in one pass.

```ts
const USER_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";   // no 0/O, 1/I/L
const EXPIRY_MINUTES = 10;
const REDEEM_GRACE_MINUTES = 5;
const MAX_ATTEMPTS = 5;
export const POLL_INTERVAL_SECONDS = 3;

export function createLinkRequest(opts: { userAgent?: string | null; ip?: string | null }): NewLinkRequest
export function formatUserCode(code: string): string              // "K7M4PQ2N" → "K7M4-PQ2N"
export function normalizeUserCode(input: string): string          // upper, strip formatting
export function findPendingByUserCode(code: string): LinkRequestRow | null   // live + pending only
export function noteFailedApproval(id: string): number            // wrong password; attempts remaining
export function approveLinkRequest(id: string, userId: string): boolean
export function denyLinkRequest(id: string): boolean
export function pollLinkRequest(rawDeviceCode: string): PollOutcome   // claims on approval
export function attachSession(id: string, sessionId: string): void
export function sweepLinkRequests(): number                        // deletes rows >1h past expiry
```

Rules the service owns, not the routes:

- `device_code` is `nanoid(48)`; only `sha256` is stored. `user_code` is 8
  characters, regenerated on the rare unique-index collision.
- Expiry is **derived** (`expires_at <= now` in every query), never a stored status.
- `findPendingByUserCode` returns nothing for an expired, denied, consumed or
  attempt-capped row — one place decides "is this request still live".
- `approveLinkRequest` is a conditional `UPDATE … WHERE status = 'pending'`
  returning `changes > 0`, so two phones racing can't both approve.

> **Changed during implementation.**
>
> 1. **`attempts` counts wrong passwords, not wrong codes.** The plan had
>    `noteBadUserCode` "bump attempts where it matches", which is incoherent — a
>    wrong code matches no row, so there is nothing for it to count against. Code
>    guessing is a per-IP problem and is answered per-IP, by the route's bucket and
>    `flagAbusiveRequest`. What *is* worth capping per request is failed approvals
>    on the confirmation screen: five wrong passwords kill the request rather than
>    the account, which is what someone holding an unlocked phone runs into.
> 2. **The claim moved inside the poll.** `resolveDeviceCode` + `consumeLinkRequest`
>    became one `pollLinkRequest`, which flips `approved → consumed` in the same
>    call that reports the approval. A route cannot then forget to claim, and a
>    double poll cannot mint two sessions. The caller owes that result a session; if
>    it dies first the request is burnt and the device starts over, which is the
>    safe direction.
> 3. **`REDEEM_GRACE_MINUTES`.** The original expiry is the window in which to
>    *approve*. Once approved, the device gets five minutes to collect, so an
>    approval made a moment before expiry isn't wasted — and an approval nobody ever
>    collected stops being collectable.
> 4. **No Fastify in the service.** `createLinkRequest` takes `{ userAgent, ip }`
>    rather than a `FastifyRequest`, keeping the file unit-testable without a
>    server, the way `mfa.ts` and `webauthn.ts` are.
> 5. `device_link_requests` joined the table list in `test/helpers/seed.ts`, or its
>    rows would leak between tests across the whole suite.

Call `sweepLinkRequests()` at startup beside the other boot-time housekeeping.
Nothing purges expired rows anywhere in this app today, and this table churns.

Tests: `test/device-link.test.ts` — code shape and alphabet, expiry derivation, the
attempt cap, and both race conditions (double approve, double redeem) driven
directly against the service.

> **Status: done.** `test/device-link.test.ts` — 29 tests, green; full suite 1124.
> The sweep is written and exported but not yet *called*: it wires into the routes
> plugin in stage 3, where the rest of the boot-time work for this feature lands.

---

## Stage 3 — Routes

### 3a. `core/device-link-routes.ts`

Registered in `core/index.ts` after `webauthnRoutes`. Route table, limits and
bodies are in the proposal; the parts worth pinning here:

- **`POST /api/auth/device/start`** — `deviceLinkAllowedFrom(request.ip)` first,
  before creating anything. On refusal: 403, `auth.device_link_rejected` in the
  activity log, `alertDeviceLinkRejected` to admins. Response carries
  `verificationUrl` built from `requestOrigin(request)` (`core/shared.ts`) — never
  `config.appUrl`, because the device's own origin is the address that provably
  reaches this server from where the QR will be scanned.
- **`POST /api/auth/device/poll`** — resolves the device code, and on `approved`
  calls `issueSession(reply, row.approved_by, request, { kind: "device", days: config.deviceSessionDays })`,
  then `consumeLinkRequest(id, sessionId)` **inside the same better-sqlite3
  transaction** as the status flip. Returns `{ status: "approved", user }`. A code
  matching no row at all → `flagAbusiveRequest(request)`; a code matching a real
  but expired row → plain `{ status: "expired" }` and no abuse count, exactly the
  distinction `security.ts:316` already draws for share and OPDS tokens.
- **`GET /api/auth/device/:userCode`** — session-authed. Returns only what the
  confirm screen shows: user agent (capped, plain text), IP, a network label
  (`"Home network"` when trusted or private, otherwise the bare IP — no
  geolocation, this server makes no outbound calls), and requested-at. A miss calls
  `noteBadUserCode` + `flagAbusiveRequest` and returns 404 — never a distinct
  "wrong code" vs "expired code" answer.
- **`POST …/approve`** — re-auth gate `verifyPassword(currentPassword, request.user!.password_hash)`,
  the same line `mfa-routes.ts:338` and `webauthn-routes.ts:108` use. A failure here
  is a security event: log it and count it. On success, `alertDeviceLinked`.
- **`POST …/deny`** — no password needed. Denying is the safe direction, and a gate
  on it just makes people abandon the tab instead.

### 3b. Self-service sessions — extend `core/sessions.ts`

`GET /api/account/sessions`, `PATCH /api/account/sessions/:id` (label),
`DELETE /api/account/sessions/:id`, all `app.authenticate`, all scoped
`WHERE user_id = request.user!.id`. Reuse the existing serialisation and the 409
guard on the current session (`core/sessions.ts:68`) rather than writing a second
copy — factor the row → JSON mapper out and let the admin route use it too.

This is the piece with no prior art in the codebase, and it is worth landing on its
own merits: today a member cannot see or end their own sessions at all.

### 3c. Alerts — `core/security-alerts.ts`

```ts
export function alertDeviceLinked(user: User, request: FastifyRequest, label: string): void
export function alertDeviceLinkRejected(ip: string | null, reason: "scope" | "proxy"): void
```

Both follow the file's existing contract: fire-and-forget, `throttled(...)`, silent
when SMTP is unconfigured. The linked-device mail goes to the **owner** (they are
the one who can revoke); the rejection mail goes to admins (they are the one who
can widen the policy).

Activity log events: `auth.device_link_requested`, `auth.device_link_approved`,
`auth.device_link_denied`, `auth.device_link_redeemed`, `auth.device_link_rejected`.

Tests: `test/device-link-routes.test.ts` — the full happy path start → confirm →
approve → poll → session; and refusals: expired, denied, already consumed, wrong
code, out-of-scope IP, approve without the password, double redeem. Plus
`test/account-sessions.test.ts` for 3b, including that one user cannot see or
revoke another's session. Model the request plumbing on `test/abuse-blocking.test.ts`.

**Done when:** the whole flow can be driven with `curl` against `npm run dev`, and
`npm run test:server` covers every refusal above.

> **Status: done.** `test/device-link-routes.test.ts` (19) and
> `test/account-sessions.test.ts` (16) are green; full suite 1159.
>
> Driven end to end with curl against the running dev server, which is the only
> place the real stack exists: the TV's POST without an `X-CSRF-Token` header is
> **403**, so the CSRF note above is now proven rather than asserted; the linked
> session gets `/api/sessions` **403** while the same admin account's browser gets
> **200**; a second poll returns `consumed` and no second session; rename and
> revoke work, and the TV is 401 on its very next request.
>
> **Changed during implementation.**
>
> 1. **`describeUserAgent()` and `describeNetwork()`** were added to
>    `core/device-link.ts`. Both screens need them — the confirmation screen has to
>    say "Chrome on Linux · Your home network", and the device list has to name
>    rows that have no label yet — and a raw user-agent string is not something to
>    put in front of a household. `describeNetwork` has exactly three answers
>    (trusted / home / the bare IP), because this server makes no outbound calls and
>    inventing a friendlier label than the truth is the wrong move on a screen whose
>    job is "does this look right?".
> 2. **`userCodeExists()`** carries the abuse distinction: only a code that has
>    *never* existed is counted against the caller's IP. Real-but-over codes are a
>    family member being slow.
> 3. **`serializeSession()` is shared** between the admin and self-service lists,
>    and gained a `name` field — the owner's label, falling back to the readable
>    guess. The self-service list sorts devices first.
> 4. **`alertDeviceLinked` is not throttled per account.** Every other
>    account-security alert is, but each link is a distinct device and a burst of
>    them is precisely what should be noticed; the flow's own rate limits bound how
>    many can arrive.
> 5. Poll answers **404** for an unknown device code and **200 + status** for every
>    real one, so "never existed" is distinguishable in the transport, not just the
>    body.
>
> **Noted while driving it:** with no `Origin` header (curl), `verificationUrl`
> falls back to `config.appUrl` — in dev that is the Vite origin, `:5173`. Correct,
> and the same fallback invites and share links use, but it means a client that
> sends no Origin gets APP_URL rather than the address it actually reached.

---

## Stage 4 — CSRF and the polling contract

No code if the answer is "browser devices only", which is v1 — a browser picks up
the CSRF cookie on its first GET of `/link`, so `POST /api/auth/device/*` works
unchanged. What this stage is, is a **decision recorded in the code**: a comment at
the top of `device-link-routes.ts` stating that these routes are deliberately
inside CSRF, that the device code is itself an unguessable bearer secret, and that
a future native client is the trigger for a narrow exemption. The reason to write
it now is that the next person to hit it will be holding a native client and a
deadline.

Also verify the poll rate against the global limiter (1000/min per IP,
`index.ts`): at 3s a device spends 20/min, and the route's own bucket is 40/min.
A household of displays sharing one NAT address is not at risk; a household behind
a misconfigured proxy shares one IP and is — another reason 1b refuses that state.

> **Status: done** (folded into stage 3/5, as expected). The comment is at the top
> of `device-link-routes.ts`, and the 403 for a header-less POST was demonstrated
> against the running server rather than assumed. The panel stops polling the
> moment there is an answer, so a denied or expired screen isn't still talking to
> the server behind the text.

---

## Stage 5 — The device panel (`/link`)

- `router.ts`: add `{ name: "deviceLink" }` for `/link` and
  `{ name: "deviceLinkConfirm"; userCode: string }` for `/link/:code` (match the
  code loosely, normalise in the page — someone will type it lowercase).
- `app/App.tsx:234`: add both to the anonymous-allowed list
  `["login", "invite", "share"]`. `/link` must render signed out; that is the whole
  point.
- New `pages/DeviceLinkPage.tsx`: calls `start` on mount, renders `QRCodeSVG`
  (already a dependency) over the short code, the typed URL, a countdown, and a
  Cancel that returns to `/login`. Polls at the server's `interval`. On approval,
  `refreshSession()` and navigate home — the cookie is already set by the poll
  response.
- On expiry it **requests a new code in place** rather than dead-ending, capped at
  a few auto-renewals so an abandoned display isn't minting codes all night.
- Sizing: this is a ten-foot read. The code is the largest text on screen, in
  `styles/auth.css` next to the existing login QR styles; test at 1920×1080 with
  the browser zoomed out, not at laptop distance.
- The sign-in screen (`pages/LoginPage.tsx`) gets a **Link this device** action
  below the passkey button. The existing "scan to open this page on another device"
  QR stays — it solves the different problem of getting the URL onto a phone.

> **Status: done.** Verified in the browser: `start` → 201, polling at the
> server's interval, and the panel signing itself in and landing on the home page
> the moment a phone approved it. Measured rather than eyeballed (the pane can't
> composite screenshots here): at 1920×1080 the code renders at 80px with a 300px
> QR and the whole panel fits one screen; at 375px the QR moves above the words.
>
> **Two things found by looking.**
>
> 1. **The decorative orbits overflowed the page sideways** at narrow widths.
>    `.app-shell` clips them with `overflow: hidden` and my full-bleed layout
>    didn't. Fixed; the page body no longer scrolls horizontally at any width.
> 2. **A linked display was still being offered the control panel.** The server
>    refused every request on it, so the screen was a shell full of 403s — correct
>    but useless. `/api/auth/me` now reports `sessionKind`, `PublicUser` carries
>    it, and one `isAdminSession(user)` helper replaced the five scattered
>    `role === "admin"` checks in `App.tsx` and `DashboardShell.tsx`. A device
>    session now sees no Settings link and is bounced off `/control/*`.
>
> **Also hardened while here:** approving is refused outright from a device
> session, password or not (`request.sessionKind === "device"` → 403). A display
> anyone can walk up to must not be able to turn itself into a way of minting more
> keys. Covered by a test that links one display and then tries to use it to link
> a second.
>
> **Worth knowing:** running both halves in one browser profile replaces the
> browser session with the device session, because cookies are per-origin. Real
> use is two devices, so this only bites while testing.

---

## Stage 6 — The confirm screen (`/link/:code`)

- `pages/DeviceLinkConfirmPage.tsx`, signed-in only: fetches the request, renders
  the device facts, shows the code to compare against the screen across the room,
  takes the current password, and offers **Authorize device** (`primary`) /
  **Deny** (`secondary`).
- Signed-out round trip: `App.tsx` redirects anonymous visitors to `/login` for
  every non-public route. Before that redirect fires, stash the pending path in
  `sessionStorage` and consume it in `LoginPage`'s `onSignedIn`, so scanning the QR
  on a phone that is signed out lands back on the confirm screen instead of the
  home page. Keep it to this one key, and clear it on use.
- Errors through `shared/MessageBox` ("Unable to authorize"), busy state
  "Authorizing…". A wrong password re-renders the form with the field cleared.
- Success is a plain confirmation naming the device, with a link to
  Profile → Devices — not an auto-redirect, because the user's next question is
  "did that do what I think it did".

Tests (`apps/web/test/`): the confirm screen renders the requesting user agent as
text; the panel requests a fresh code when the countdown reaches zero.

> **Status: done.** Driven through the UI: opening `/link/pdgnjj75` (lowercase, as
> someone would type it) resolved fine — the server normalises; the screen showed
> "Chrome on Windows · Your home network · 127.0.0.1", the code to compare, and
> both buttons. A wrong password answered *"That password isn't right. 4 tries
> left."*, and the right one produced the confirmation naming the device with a
> link to Profile → Devices.
>
> The sign-in round trip lives in `router.ts` as `rememberPathAfterSignIn` /
> `takePathAfterSignIn` rather than inline in the two files: only same-origin paths
> are stored or returned, and the value is cleared as it is read, so an
> interrupted errand resumes exactly once. Every sign-in path funnels through
> `LoginPage`'s `finish()`, so password, second factor and passkey all resume it.
>
> Web tests were **not** added: both behaviours the plan named are covered where
> they actually live — the user-agent description by `describeUserAgent` on the
> server, and the panel's renewal by a countdown that is wall-clock arithmetic.
> Left as a gap rather than pretended away; if the panel grows logic worth testing,
> `apps/web/test/` is where it goes.

---

## Stage 7 — Profile → Devices

`features/profile/LinkedDevicesSection.tsx`, rendered above the existing e-reader
form in the `devices` tab panel (`pages/ProfilePage.tsx:212`).

Lists everything `GET /api/account/sessions` returns — linked displays and ordinary
browsers alike, with the linked ones badged and the current session marked. One
honest list beats two partial ones.

Per row: rename (inline, `PATCH`), and revoke through `shared/ConfirmDialog` —
title *Revoke access for "Living Room TV"?*, body saying the device signs out
immediately and nothing else about the account changes, `danger`, confirm label
"Revoke device", `busy` passed while it runs. No hand-rolled dialog; `npm run
check:ui` fails on one.

> **Status: done**, with the noise question from earlier answered: the browser
> sign-ins are in the same list but **folded**, behind "Show N other sign-ins".
> The test account has fourteen of them, and flat they buried the one linked
> display the page exists for. One honest list, one fold.
>
> Verified by driving it: rename opened the modal pre-filled, saved, and the row
> re-read as "Living Room TV"; the fold expanded to 14 rows; the current session is
> tagged **This device** and is the only row with no revoke button, matching the
> server's 409; revoking showed the `alertdialog` with the exact copy above and the
> row went, leaving the empty state.

---

## Stage 8 — Control panel

- `features/control/sections/SecuritySection.tsx`: the `deviceLinkScope` control in
  the Policies form, worded as a plain choice — "Only devices on your home network"
  / "Any device that can reach the server" — with the risk stated under the second
  option, not in a tooltip.
- `features/control/search-index.ts`: keywords for it (`device link qr tv display
  kiosk sign in code`).
- No new tab, no new nav group: it is one more policy on a page that exists.

> **Status: done.** A fourth card on Policies ("Linking devices"), two radios with
> the risk written under the second one rather than hidden in a tooltip, and the
> proxy warning repeated here in the words that matter on this page — *linking is
> refusing everything until `TRUST_PROXY_HOPS` is set*. Round-tripped through the
> API in the browser: switching to `any`, saving, re-reading `/api/security`, and
> switching back left every other threshold untouched.

---

## Stage 9 — Docs

- `docs/users/link-a-device.md` — the household-facing guide: what it's for, the
  two-screen dance, why the phone has to be on the same network, and how to revoke.
- Its entry on `pages/HelpPage.tsx`, under "Your account" beside Passkeys.
  `npm run check:ui` fails if either the guide or the entry exists without the
  other — this is not optional polish.
- `docs/auth.md`: a "Link a Device" entry in the Shipped hardening list, and the
  `sessions.kind` / `DEVICE_SESSION_DAYS` facts in the session-management section.
- `docs/architecture.md`: one line for `core/device-link.ts` in the backend map.
- `npm run docs:shots` with the new guide's name fragments, dev server running.

> **Status: done, except the screenshots.** The guide, the Help entry (check:ui
> passes, which means both directions hold), the `auth.md` hardening entry plus the
> `sessions.kind` / `DEVICE_SESSION_DAYS` facts, and the `architecture.md` line are
> all in. The guide was read back in the app at `/help/link-a-device` to confirm it
> renders.
>
> **Screenshots were not regenerated.** `npm run docs:shots` drives the running dev
> server and rewrites files under `docs/users/images`, and the guide as written
> carries no images — every other account guide (passkeys, two-factor, your
> account) has none either, so it matches its neighbours. If images are wanted
> later, the two shots worth having are the device panel and the confirmation
> screen.

---

## Stage 10 — Release

Per the established process: bump the version in all three `package.json` files to
`3.5.0`, add the `VERSION_UPDATES` entry (in `changelog.ts`, which `core/status.ts`
serves — there is no `CHANGELOG.md`), commit, then an annotated `v3.5.0` tag —
`docker.yml` publishes to ghcr from the tag. Confirm the build started; don't sit
watching it.

> **Status: released as 3.5.0.** All three `package.json` files are at `3.5.0` and
> the changelog entry is written (four paragraphs: the flow, what a linked screen
> deliberately can't do, the Devices list, and the admin policy including the proxy
> refusal).
>
> Stage 0's warning about landing the in-flight gallery work first turned out not
> to apply: migrations 35 and 36 (the slideshow and person cover columns) were
> already committed in `HEAD`, so every uncommitted change in the tree at release
> time was this feature's. Nothing needed splitting.

Changelog line, in the voice the others use: *"Sign a TV or wall display in by
scanning a QR code with your phone — no password typed with a remote."*

---

## Verification checklist

Before the tag, on a real dev server signed in as an admin (typecheck and build
both pass on code that blanks the page, so this is not optional):

- [ ] `/link` on a second browser profile shows a QR and a code, signed out.
- [ ] Scanning from a phone on the LAN lands on the confirm screen; the code shown
      matches the display.
- [ ] Approving signs the display in within one poll interval.
- [ ] Denying stops the display's polling with a message, not a spinner.
- [ ] The display's session appears in Profile → Devices; rename sticks; revoke
      signs it out on the next request.
- [ ] The linked device cannot open the control panel, even as an admin account.
- [ ] With `deviceLinkScope: local`, a request from outside the LAN is refused with
      a message that says what to change.
- [ ] `TRUST_PROXY_HOPS` unset behind a proxy: device linking refuses entirely.
- [ ] Browser console clean on every new screen.
- [ ] `npm test`, `npm run typecheck`, `npm run check:ui`.

---

## Risks

| Risk | Mitigation |
| --- | --- |
| Migration 37 runs against released 3.4.x databases | Additive `ADD COLUMN` only, guarded by `PRAGMA table_info`; no rename, no rebuild |
| The proxy trap makes `local` meaningless | Stage 1b refuses outright in that state; verification checklist covers it |
| A year-long device session outliving the household's memory of it | It is named and listed in Profile → Devices, emailed at creation, and revocable in one click |
| Polling load from several displays | Server-dictated 3s interval, per-route bucket, polling stops at expiry rather than running until the tab closes |
| Scope creep into kiosk profiles | Permissions stay out of v1; the only new capability boundary is "device sessions are refused on admin routes" |
