# Link a Device — proposal

Sign in a TV, wall display, kiosk, or shared tablet by scanning a QR code with a
phone that is already signed in, instead of typing an email and password with a
remote control.

The model is the OAuth 2.0 Device Authorization Grant (RFC 8628), narrowed to what
a self-hosted single-server household app actually needs.

---

## Why this, when passkeys exist

Passkeys (`core/webauthn.ts`) are the better answer everywhere they work, and they
already ship. They cannot reach the devices this proposal is for:

- WebAuthn needs a secure context and a registrable domain. The default install is
  plain http on a LAN, where passkeys are unavailable outright.
- TV and set-top browsers rarely have a platform authenticator, and hybrid
  (phone-as-authenticator) transport is patchy to absent on them.
- A wall display has no user present to make a biometric gesture on every sign-in.

So this is additive, in the same way passkeys were: password + code stays the
universal path, and this is the path for devices with bad input.

---

## What already exists (build on it, don't restate it)

| Need | Already in the repo |
| --- | --- |
| QR rendering | `qrcode.react` on the web (`OpdsAccessSection.tsx`, `LoginPage.tsx:204`), `qrcode` on the server (MFA setup) |
| Per-device records | `sessions` carries `device_name`, `ip_address`, `last_seen_at`, `revoked_at` (`schema.sql:51`) |
| A Devices home in Profile | `/profile/devices` exists (`router.ts:181`) — today it holds the e-reader address and the install-the-app card |
| Brute-force + abuse controls | `core/security.ts` — lockout, per-IP auto-block, `recordAbuseAttempt`, trusted networks |
| Rate limiting | Global 1000/min per IP with a trusted-network allowlist (`index.ts`), routes tighten it individually |
| Origin for links | `requestOrigin()` in `core/shared.ts`, the same way invite links are built |
| Audit + alerts | `logActivity`, `core/security-alerts.ts`, `core/notifications.ts` |

Two things do **not** exist and this feature needs them:

1. **A self-service session list.** `/api/sessions` is admin-only
   (`core/sessions.ts:19`). "Your Devices" needs `/api/account/sessions`, listing
   *all* of a user's sessions — not only linked ones, or the household ends up with
   two competing lists of the same thing.
2. **Any notion of what kind of session a session is.** `requireAdmin` reads
   `request.user.role` and nothing else (`auth.ts:68`), so a linked TV would be
   indistinguishable from the owner's laptop.

---

## Threat model

The controls below are ordered by what they actually stop. Expiry and single-use
codes are table stakes and stop the weakest attack; they are not the interesting
ones.

### T1 — Code phishing (the real risk)

An attacker starts a device flow on their own machine and sends a household member
the QR or the code — "scan this to see the holiday photos". The victim, already
signed in, approves. The attacker now holds a session for the victim's account.

Short expiry does not help; the attack takes twenty seconds. Neither does code
entropy — the victim is handed the code. Answers:

- **`deviceLinkScope` policy, default `local`.** A link request is only created
  when the requesting IP is on a trusted network (`isTrustedIp`) or in a private
  range. A wall display is always on the LAN; with this on, a remote attacker
  cannot open a request at all. An admin can widen it to `any` under Control panel
  → Security → Policies, with the risk spelled out next to the switch.
- **The QR carries no approval.** It opens the confirm screen with the short code
  shown, and the approver must match it against the code on the screen in front of
  them. Prefilling and auto-approving from a scan deletes the only human check in
  the flow.
- **Re-authentication at approval** — current password, or a passkey where one is
  registered. This is the same gate that governs MFA enrollment, MFA disable, and
  passkey registration (`mfa-routes.ts:338`, `webauthn-routes.ts:108`). Minting a
  year-long session from an unlocked phone should cost at least as much as turning
  off two-factor.
- **The owner is told.** An email on every successful link, in the shape of the
  existing account-security alerts (`core/security-alerts.ts`), plus an activity
  log entry whether or not SMTP is configured. This is the backstop for every case
  where the controls above are widened or worked around, so it is v1, not a future
  enhancement. There is no in-app notification system to hang this on — the
  `notification_settings` blob is an opt-in gate for member-facing *email*, and it
  deliberately does not cover security mail.

**The trap in `deviceLinkScope: local`.** Behind a reverse proxy with
`TRUST_PROXY_HOPS` unset, `request.ip` is the proxy — typically a Docker-private
`172.x` address. Every request then looks local and the control silently permits
the entire internet. The server already warns about this at startup for the other
per-IP controls (`index.ts`). Device linking must go further and **refuse
outright** when a forwarded header has been seen and the hop count is unset: the
other controls degrade toward noise, this one degrades toward an open door.

### T2 — Code guessing

Someone enumerates user codes to reach a pending request. Answers: 40 bits of
entropy over an unambiguous alphabet, a 5-attempt cap per request, a tight route
bucket, and `recordAbuseAttempt` on codes that match no row at all — the same
treatment unknown share and OPDS tokens get (`security.ts:316`). A code that
matches a real-but-expired request is deliberately *not* counted, for the same
reason a stale share link isn't: that is a family member being slow, not an attack.

### T3 — The device itself is in a semi-public room

Whoever walks past the wall display holds that session. Answers: device sessions
are marked as such and refused on admin routes (below), they appear by name in the
owner's device list, and revoking is one click. Full per-device permissions are
deferred, but the admin-route refusal is not — otherwise linking an admin account
to a hallway screen puts the control panel one tap from anyone in the room.

### T4 — Hostile input from the requesting device

The device is not trusted to describe itself. v1 accepts **no** client-supplied
device name; the name is derived from the user agent and the owner renames it
afterwards from their own device list. Everything shown on the confirm screen
(user agent, IP) is rendered as text with a length cap.

---

## v1 scope

**In**

- Device panel: QR + short code + expiry + cancel, refreshing itself when the code
  expires.
- Approve flow on the phone: sign in if needed → confirm screen showing what is
  asking → re-auth → Authorize / Deny.
- Device redeems its approval for a session of kind `device`, with its own longer
  expiry.
- `/api/account/sessions` — the owner's own sessions, with rename and revoke.
- Profile → Devices grows a "Linked devices" section above the existing e-reader
  and install cards.
- Admin policy `deviceLinkScope` (`local` | `any`), default `local`.
- Activity log events, owner notification + email, admin alert on repeated failed
  code entry.

**Out (deferred, in rough order of appeal)**

- Push approval to an already-trusted phone.
- Passkey-only approval as an alternative to the password gate.
- Restricted / kiosk profiles and per-device permissions.
- "Mark this display as trusted, don't ask again".
- Automatic naming from device type.

---

## User flow

### 1. Device asks

The device opens `/link` (or picks **Link this device** on the sign-in screen) and
gets:

```text
Sign in to iSputnik

[ QR CODE ]

Scan with your phone — it must be on the same network as the server

or open   http://tower.local:4000/link
code      K7M4-PQ2N

Expires in 10 minutes                    Cancel
```

The URL is built from the device's own origin, never a hardcoded domain — there is
no `isputnik.app`; every install answers on its own address. The panel says the
phone must be on the same network, because on a LAN-only install a phone on mobile
data cannot reach either the QR target or the typed URL.

Type sizes are set for a ten-foot read: the code is the largest text on the screen.

### 2. Phone confirms

The QR opens `/link/K7M4-PQ2N`. If not signed in, the normal sign-in runs first
(password, MFA, or passkey — all unchanged), then returns here.

```text
Authorize this device?

Chrome on Linux
192.168.1.42 · Home network
Requested just now

Check the code on that screen matches:   K7M4-PQ2N

[ Current password ]

Deny                              Authorize device
```

If scanning isn't possible, the same screen is reached by opening `/link` and
typing the code.

### 3. Device signs in

The device is polling; on approval it redeems its device code for a session and
enters the app. A denial ends the polling with a plain message, not a retry loop.

### 4. Afterwards

Profile → Devices lists it as **Living Room TV** (renameable) with last-seen and
network, and a **Revoke** action. The owner has an email saying it happened.

---

## Data model

### New table — `device_link_requests`

New tables need no `migrations[]` entry: `schema.sql` is idempotent and applied in
one pass (`db/migrate.ts`).

```sql
CREATE TABLE IF NOT EXISTS device_link_requests (
  id                TEXT PRIMARY KEY,
  device_code_hash  TEXT NOT NULL UNIQUE,   -- sha256 of the device's secret, like sessions/api_tokens
  user_code         TEXT NOT NULL UNIQUE,   -- the short code shown on screen
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','denied','consumed')),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at        TEXT NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,   -- wrong-code entries against this request
  user_agent        TEXT,
  ip_address        TEXT,
  approved_by       TEXT REFERENCES users(id) ON DELETE CASCADE,
  approved_at       TEXT,
  session_id        TEXT REFERENCES sessions(id) ON DELETE SET NULL
);
```

Notes on the shape:

- **No `expired` status.** Expiry is `expires_at <= now`, evaluated in every query.
  A stored state has to be swept to be true, and until the sweep runs the UI shows
  a stale "pending".
- **`session_id`** links the redeemed session back to the request, so a revoke in
  the device list can name the request in the audit trail.
- **`device_code_hash`, not `device_code`** — same rule as sessions, share links,
  and API tokens: the raw secret exists only in the device's memory.
- Rows want deleting an hour past expiry. Nothing purges expired rows anywhere in
  this app today — expired sessions are simply ignored by the auth check
  (`docs/auth.md`) — but sessions are a handful per household and these are one
  per attempt, so this table needs a sweep on startup. Nothing needs the history;
  the activity log has it.

Code shapes:

- `device_code` — `nanoid(48)`, the session-token shape.
- `user_code` — 8 characters from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` (no `0/O`,
  `1/I`), displayed as `K7M4-PQ2N`. 40 bits, and unambiguous when read off a TV
  across a room. Input is upper-cased and de-hyphenated before lookup.

### Changed table — `sessions`

Two new columns on an existing table, so this **does** need a migration entry — the
next free version (37 as of writing):

```sql
kind   TEXT NOT NULL DEFAULT 'browser' CHECK (kind IN ('browser','device'))
label  TEXT      -- owner-given name; falls back to device_name (the user agent)
```

`issueSession` (`auth.ts:15`) grows options for `kind` and lifetime. Device
sessions use `DEVICE_SESSION_DAYS` (default 365) instead of `SESSION_DAYS`
(default 14) — a wall display that logs itself out every two weeks needs a human
with a remote control, which is the problem this feature exists to remove. The long
life is affordable precisely because the session is visible, named, revocable, and
barred from admin routes.

`app.requireAdmin` gains one line: a session of kind `device` is refused, whatever
the account's role.

### New policy field

`SecurityPolicy` in `core/security.ts` gains `deviceLinkScope: "local" | "any"`,
default `"local"`. The policy blob is merged over the defaults on read, so an
existing install picks up the safe default without a migration.

`core/cidr.ts` gains `isPrivateIp()` (RFC1918, loopback, link-local, ULA), built on
the existing `ipInAnyCidr`.

---

## API

All under `core/device-link.ts` + `core/device-link-routes.ts` — the service/routes
split `mfa.ts` / `mfa-routes.ts` and `webauthn.ts` / `webauthn-routes.ts` already
use, so the logic is unit-testable without a server.

| Route | Auth | Limit | Does |
| --- | --- | --- | --- |
| `POST /api/auth/device/start` | none | 5/min per IP | Refuses unless the caller passes `deviceLinkScope`. Creates a request. Returns `deviceCode`, `userCode`, `verificationUrl`, `expiresAt`, `interval` |
| `POST /api/auth/device/poll` | none | 40/min per IP | Body `{ deviceCode }`. Returns `pending` / `denied` / `expired`, or `approved` **and issues the session cookie**, marking the request `consumed` |
| `GET /api/auth/device/:userCode` | session | 20/min | The confirm screen's data: user agent, IP, network label, requested-at. 404 for anything not pending-and-live; counts wrong codes toward `attempts` and `recordAbuseAttempt` |
| `POST /api/auth/device/:userCode/approve` | session | 10/min | Body `{ currentPassword }` (or a passkey assertion). Marks approved, records `approved_by` |
| `POST /api/auth/device/:userCode/deny` | session | 10/min | Marks denied |
| `GET /api/account/sessions` | session | — | The caller's own sessions: id, kind, label, device, IP, created, last seen, `current` |
| `PATCH /api/account/sessions/:id` | session | — | Rename (`label`) |
| `DELETE /api/account/sessions/:id` | session | — | Revoke. 409 on the current session, mirroring `core/sessions.ts:68` |

Polling and CSRF: these are unauthenticated POSTs, and CSRF applies to every
state-changing request (`core/csrf.ts`). A browser device picks up the token cookie
on its first GET, so the web path works unchanged. A future native client will not
— when that arrives, `/api/auth/device/*` gets a narrow exemption justified by the
fact that the device code is itself an unguessable bearer secret. Deciding it now
rather than discovering it later is the point of this paragraph.

`interval` is returned so the device polls on the server's terms (3s). Polling
stops at expiry rather than running until the tab is closed.

---

## Web surface

- **New route** `/link` (device panel) and `/link/:userCode` (confirm), declared in
  `router.ts` and reachable while signed out — `/link/:code` sends an anonymous
  visitor through sign-in and back.
- **Sign-in screen** gains a **Link this device** action. The existing "scan to open
  this page on another device" QR (`LoginPage.tsx:204`) stays; it solves the
  different problem of getting the URL onto a phone.
- **Profile → Devices** grows a "Linked devices" section above the e-reader form.
  Given `/api/account/sessions` returns everything, the section lists all of the
  owner's sessions with linked devices called out — one honest list.

Conventions, all enforced by `npm run check:ui`:

- `shared/Button` with explicit variants; the confirm screen's actions are
  `primary` ("Authorize device") and `secondary` ("Deny").
- Revoke goes through `shared/ConfirmDialog`: *Revoke access for "Living Room TV"?*
  — body says the device signs out immediately and nothing else is affected —
  `danger`, confirm label "Revoke device".
- Errors and notices via `shared/MessageBox` with a tone. "Unable to authorize",
  never a bare div.
- Busy states repeat the verb: "Authorizing…", with `busy` passed to the dialog.
- No hand-rolled modal, no `window.confirm`.

The device panel is a full-page layout, not a modal: it is the only thing on that
screen and it must read from across a room.

---

## Audit, alerts, notifications

Activity log events, following the existing `auth.*` naming:

- `auth.device_link_requested` — a request was opened (IP, user agent)
- `auth.device_link_approved` / `auth.device_link_denied` — with the actor
- `auth.device_link_redeemed` — a session was issued
- `auth.device_link_rejected` — a request refused by `deviceLinkScope`
- `session.revoked` — reused as-is for revoking from the device list

Email, through `core/security-alerts.ts` (fire-and-forget, throttled, silent when
SMTP is unconfigured — the same contract every other alert has):

- **Owner, on every successful link** — what was linked, from where, and how to
  revoke it.
- **Admins**, when a link request is refused by policy or an IP burns through code
  attempts, reusing the shape of the repeated-two-factor-failure alert.

Nothing is needed on the sending side beyond two new `alert…()` functions.

---

## Tests & docs (part of the definition of done)

Server (`apps/server/test/`):

- A full happy path: start → confirm → approve → poll → session issued → request
  `consumed` and not redeemable twice.
- Refusals: expired, denied, already consumed, wrong code, request from outside the
  policy scope, approval without the password.
- The attempt cap and that unknown-vs-expired codes are counted differently.
- A device session is refused by `requireAdmin` even for an admin account.
- `/api/account/sessions` shows only the caller's own, and 409s on the current one.

Web (`apps/web/test/`): the confirm screen renders the requesting device's details
as text, and the device panel refreshes its code on expiry.

Docs:

- `docs/users/link-a-device.md`, **and** its entry on the in-app Help page —
  `check:ui` fails if either exists without the other.
- A "Link a Device" entry in the hardening list in `docs/auth.md`.
- Screenshots via `npm run docs:shots`.
- `features/control/search-index.ts` terms for the new security policy.

---

## Terminology

- **Link a device** — the action
- **Authorize device** — the confirmation
- **Device code** — the short code on screen
- **Linked devices** — the list in Profile → Devices

Not "one-time password": the code does not authenticate anyone, it names a pending
request. Also not "token", which in this app already means an OPDS reader token.

---

## Open questions

1. **Should a member be able to link a device at all, or is this admin-only?** The
   proposal assumes any signed-in user can link a device to their own account.
2. **Sliding expiry for device sessions?** A fixed 365 days is simpler; a sliding
   window keeps a daily-use display alive forever and drops an abandoned one
   sooner. Fixed is proposed; sliding is a one-line change if the household
   disagrees.
3. **Does the confirm screen show a network label the household will understand?**
   "Home network" is easy when the IP is trusted or private; anything else is bare
   IP, and no geolocation lookup will happen here — that would mean an outbound
   call from a server that deliberately makes none.
