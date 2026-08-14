# Remote device linking — implementation plan

Follow-up to [`iSputnik-Link-a-Device-Plan.md`](iSputnik-Link-a-Device-Plan.md),
which shipped as 3.5.0. That release deliberately refuses to link a device from
outside the house, with one escape hatch: an admin setting the policy to `any`,
which opens the door permanently for everyone.

This replaces that blunt setting with a **time-boxed, per-user registration
window**: an admin turns linking on for one person for one hour, the first device
they link closes it, and the rest of the time the option is not even offered
outside the house.

Target release: **3.6.0** (current is 3.5.0). Branch: `feat/remote-device-window`.

---

## Why a window rather than a code

The alternative considered was an admin-issued pass code, typed on the device. It
leaks nothing and pins the request to one user from the very first call — but it
asks someone to type a code on a television, which is the exact thing this whole
feature exists to avoid. The window costs a small, bounded disclosure (below) and
nothing else; it wins.

Both are enormously better than `deviceLinkScope: "any"`, which is a door with no
name on it and no closing time.

**Do not solve this with trusted networks.** Adding the remote site's CIDR would
let linking through, but `isTrustedIp` also exempts that address from MFA, account
lockout, and rate limiting (`auth-routes.ts`). That is not a workaround, it is a
much larger hole wearing this feature's clothes.

---

## How it hangs together

`POST /api/auth/device/start` is **anonymous** — the device cannot say whose it is
— so a per-user window cannot be enforced there. It resolves in three steps
instead, and the step that carries an identity is the one that already has a
password behind it:

| Step | Check |
| --- | --- |
| `start` | From outside: allowed only if **some** live window exists. Otherwise refused exactly as today. The request records that it came from outside. |
| `approve` | If the request is flagged remote, the approving account must hold a **live window of its own**. This is where "for user `test`" is actually enforced. |
| redeem | A successful link **closes that window**. |

So "enable as often as you like, one device each time" falls out of the last row:
a window ends on the first device linked, or when the hour is up, whichever comes
first.

### Decisions taken (change them here if you disagree)

1. **Sixty minutes, fixed, no picker.** The number matches "I am setting this up
   right now", and a duration control is a way to leave a door open for a week by
   accident. An admin who needs longer can grant again.
2. **A live window overrides the misconfigured-proxy refusal.** Behind a proxy
   with `TRUST_PROXY_HOPS` unset the server cannot tell where anything is, and
   3.5.0 therefore refuses all linking. An open window is an explicit statement
   that location does not matter for the next hour, so it goes through. The cost:
   that configuration error no longer blocks every path. The startup warning and
   the Policies-page warning both stay.
3. **Windows are per user, not per device or per "application".** Nothing in the
   flow can identify a device before it exists.

### The disclosure, stated plainly

The sign-in screen has to know whether to offer **Link a TV or display**, and it
asks before anyone signs in. So during an open window, an anonymous caller from
anywhere can learn that *a* window is open — not whose, not for how long.

That is a real signal: it says "now is the moment someone in this household is
expecting to approve a device", which is the best moment to attempt a phishing
approach. What stands in the way is unchanged from 3.5.0 — the confirmation screen
names the device and its network, the code has to match the screen in front of
them, and approving takes their password. The window is an hour and shut the rest
of the time.

The alternative is to keep the button visible outside and let it fail, which
teaches people to ignore a refusal. Worse.

---

## Stage 1 — The window itself

### 1a. Schema

New table, so `schema.sql` only — no `migrations[]` entry.

```sql
-- An admin's temporary permission for ONE person to link ONE device from outside
-- the house. Live means: not used, not revoked, not past expires_at. The first
-- device to link against it fills used_at/session_id and it is over.
CREATE TABLE IF NOT EXISTS device_link_windows (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_device_link_windows_user ON device_link_windows (user_id, expires_at);
```

One new column on `device_link_requests` — an existing table, so this **does** need
a migration entry (**version 38**, additive, `PRAGMA table_info` guarded):

```sql
remote INTEGER NOT NULL DEFAULT 0 CHECK (remote IN (0, 1))
```

`remote` is set at creation, from the same verdict that allowed the request. It is
the memory of "this one arrived from outside", which `approve` needs later and
cannot re-derive — by then the phone is the caller, and the phone's address says
nothing about where the television is.

### 1b. Service — extend `core/device-link.ts`

```ts
export const WINDOW_MINUTES = 60;

export function openLinkWindow(userId: string, createdBy: string): LinkWindowRow
export function liveWindowFor(userId: string): LinkWindowRow | null
export function anyLiveWindow(): boolean
export function closeLinkWindow(id: string, sessionId: string | null): void   // used
export function revokeLinkWindow(userId: string): boolean                     // cancelled early
export function listLiveWindows(): LinkWindowRow[]                            // for the admin UI
export function sweepLinkWindows(): number                                    // beside sweepLinkRequests
```

Liveness is derived in SQL every time (`used_at IS NULL AND revoked_at IS NULL AND
datetime(expires_at) > datetime('now')`) — the same rule as the request table, for
the same reason: a stored state has to be swept to become true.

`openLinkWindow` replaces any existing live window for that user rather than
stacking a second one, so "how long have I got?" has one answer.

### 1c. The gate — `core/device-link.ts`, layered over `core/security.ts`

> **Changed during implementation.** The plan said `deviceLinkAllowedFrom` in
> `security.ts` would grow a third outcome. It can't: `device-link.ts` already
> imports `security.ts` (for `isTrustedIp`), so having `security.ts` reach back for
> `anyLiveWindow` is an import cycle. And it shouldn't — `security.ts` is platform
> infrastructure with no product knowledge, and registration windows are product.
>
> Instead `deviceLinkAllowedFrom` keeps its exact meaning ("is this address local
> or trusted, and can this deployment tell?") and a new `deviceLinkAccess()` in
> `device-link.ts` layers windows on top. The dependency runs one way, the layering
> rule in CLAUDE.md holds, and the composed answer still has exactly one home.

`deviceLinkAccess` returns:

```ts
// local / trusted            → { allowed: true, remote: false }
// outside, a window is open  → { allowed: true, remote: true }
// outside, no window         → { allowed: false, reason: "scope" }
// proxy misconfigured, no window → { allowed: false, reason: "proxy" }
```

Keeping the `remote` flag on the verdict is what lets the route record it without
asking the same question twice and risking two different answers.

Tests: `test/device-link-window.test.ts` — each cell of that table, plus the proxy
case with and without a window, plus a window that has expired, been used, or been
revoked counting as no window at all.

> **Status: done.** 15 tests green; full suite 1281 (1175 server + 106 web);
> typecheck clean.
>
> Rehearsed against a database built on the **released 3.5.0 schema** and stamped
> at 37: `remote` lands defaulting to 0, `device_link_windows` arrives with the
> columns the service expects, an in-flight link request keeps its status and
> session, a linked device session is untouched, the CHECK bites, and `migrate()`
> stays safe to re-run. The live dev database came up at `user_version` 38 with all
> 14 sessions intact and `integrity_check` ok.
>
> Two small things decided while writing it:
>
> - **`openLinkWindow` revokes any existing window** for that person rather than
>   stacking a second, so "how long have I got?" has one answer. The superseded row
>   is closed, not deleted — the grant still happened and the log should show it.
> - **`closeLinkWindow` is conditional on `used_at IS NULL`**, so a second call
>   can't overwrite which session actually spent the window.
>
> `sweepLinkWindows()` exists and is tested but is not yet *called* — it joins the
> boot-time sweep in stage 2, beside `sweepLinkRequests()`.

---

## Stage 2 — Routes

### 2a. `core/device-link-routes.ts`

- **`start`** — unchanged in shape; stores `remote` from the verdict. The refusal
  copy stays as it is: a household member outside with no window should be told
  linking is only allowed from home, not that a window might be arranged, which is
  a conversation to have with the admin rather than a hint from a sign-in screen.
- **`approve`** — after the existing password check, and only when
  `row.remote === 1`: `liveWindowFor(user.id)` must return a window. If it does
  not, **403** — "Linking a device from outside has to be turned on for your
  account by an administrator." The password check stays first, so a wrong password
  never reveals whether a window exists.
- **redeem (`poll`)** — when the claimed request is `remote`, close the approver's
  window with the new session id, in the same transaction as the claim.

### 2b. Admin actions — `modules/users/users.ts`

Both `requireAdmin`, mirroring `POST /api/users/:id/mfa/reset` exactly (that route
is the template — 404 on an unknown user, `logActivity`, `{ ok: true }`):

- `POST /api/users/:id/device-link-window` — opens one, returns `expiresAt`.
- `DELETE /api/users/:id/device-link-window` — cancels early.

Live windows ride along on the existing admin user list payload
(`liveWindowFor(user.id)?.expires_at`), so the Users table can show a countdown
without a second request per row.

Activity log: `user.device_link_window_opened`, `…_cancelled`,
`auth.device_link_remote` (a device actually linked from outside — the one worth
finding later).

### 2c. Alerts — `core/security-alerts.ts`

- `alertRemoteDeviceLinked(user, request, label)` → **admins**. They granted the
  exception; they should see it land. The owner already gets the 3.5.0 email.
- No alert for merely opening a window — the admin did that themselves, and it is
  in the activity log.

### 2d. The probe — `core/setup.ts`

`/api/setup/status` gains `deviceLinkAvailable: deviceLinkAllowedFrom(...).allowed`.
It is the call the app already makes before rendering, so the sign-in screen learns
this without a second request — the same argument `passkeysAvailable` makes there.

**Its comment must not copy `passkeysAvailable`'s reassurance.** That one is safe
because it restates what the address bar already shows. This one genuinely tells an
anonymous caller that a window is open, and the comment should say so, and say why
that is accepted (see the disclosure section above).

Tests: `test/device-link-window.test.ts` (service + policy) and additions to
`test/device-link-routes.test.ts` — the full remote path start → approve → redeem
with a window; approve refused with no window; approve refused when the window
belongs to a *different* user; the window closing on the first link so a second
device is refused; a window expiring mid-flow.

> **Status: done.** 27 route tests (7 new), 12 in a new
> `test/device-link-window-admin.test.ts` for the admin endpoints and the probe;
> full suite 1300 (1194 server + 106 web); typecheck clean. The admin half was also
> driven against the running dev server: granting shows up on the user list,
> cancelling clears it, and the probe answers.
>
> **Changed during implementation.**
>
> 1. **The window closes after `attachSession`, not "in the same transaction as the
>    claim".** It can't be the same transaction — the session does not exist at
>    claim time, which is the whole reason the claim happens first. A crash in that
>    gap leaves a window open, and it expires on its own within the hour.
> 2. **Two new activity events** beyond the plan's list:
>    `auth.device_link_remote_refused` (someone tried to approve a remote request
>    with no window — worth seeing, since it means a request from outside reached a
>    real account) and `auth.device_link_remote` replacing the ordinary
>    `…_redeemed` when the link was remote.
> 3. **Cancelling a window that isn't open answers `{ok: true, closed: false}`**
>    rather than 404. The caller's intent is "make sure it is shut", and it is.
>    Nothing is logged in that case — there was no grant to revoke.
> 4. **Granting for a deactivated account is a 409**, not a silent success.
> 5. `sweepLinkWindows()` joined the boot sweep beside `sweepLinkRequests()`.
>
> **A test worth naming:** *"leaves the house alone: a local request needs no window
> and burns none"* — a window open for someone travelling must not be spent by
> whoever links a display in the kitchen while they are away.

---

## Stage 3 — Web

### 3a. The sign-in screen

`LoginPage` renders **Link a TV or display** only when
`session.deviceLinkAvailable` (threaded from the `/api/setup/status` fetch that
`App.tsx` already does, alongside `passkeysAvailable`). Outside the house with no
window open, the option is not there.

`/link` itself keeps its own refusal screen — someone can still type the URL, and
the panel already handles `reason: "scope"` and `"proxy"` properly.

### 3b. Control panel → Members → Users

Per-user action, next to the existing Reset two-factor / Reset passkeys:

- **Allow a device from outside** → opens a window, and the row shows a live chip:
  *"Remote linking · 47 min left"* with a **Cancel** beside it.
- Confirmation before opening it, through `shared/ConfirmDialog` — title *Allow
  {name} to link a device from outside?*, body saying it lasts an hour, ends as
  soon as one device is linked, and that they will still need their password.
  Not `danger`; this is permission-granting, not destruction.

The chip is the whole admin UI. No new tab, no new page: it is one more thing a
user row can be doing.

`features/control/search-index.ts`: terms on the users tab — `remote device link
window allow outside away travel one hour temporary`.

> **Status: done.** Full suite 1303 (1194 server + 109 web); typecheck and
> `check:ui` clean.
>
> Verified in the browser on the Users page: granting shows the confirmation with
> the copy above, the row grows a **Remote linking · 60 min left** chip and its
> action swaps to Cancel, and cancelling puts both back. The probe was checked from
> both sides against the running server — `true` for a LAN caller, `false` for one
> carrying a forwarding header with no `TRUST_PROXY_HOPS`, which is the state where
> the server genuinely cannot tell where anyone is.
>
> **The hiding half is covered by a test rather than by the browser.** Poking the
> live page proved nothing: `deviceLinkAvailable` is read once at boot with the rest
> of `/api/setup/status`, so patching `fetch` afterwards doesn't change what the app
> already holds, and the button stayed visible for reasons that had nothing to do
> with the feature. `apps/web/test/LoginPage.test.tsx` renders the screen both ways
> instead — three tests, including one that the password form survives either way.
> That also closes the "no web tests" gap left open by 3.5.0's stage 6.
>
> **Changed during implementation.** The chip lives in the name cell beside
> Protected/Locked, as a `status-badge device-window` in amber — a state to notice,
> not a fault (rose) or a fact (grey), and with `text-transform: none` because
> "Remote Linking · 47 Min Left" is not a sentence anyone wrote. The row's action
> button *swaps* between Allow and Cancel rather than showing both, since exactly
> one of them is ever meaningful.

---

## Stage 4 — Docs

- `docs/users/link-a-device.md` — a new section, **Linking a device while away
  from home**: what to ask your administrator for, that it lasts an hour and one
  device, and that everything else about approving is the same. The existing
  "For administrators" section gains how to grant and cancel one, and why this is
  better than switching the policy to allow everything.
- `docs/auth.md` — extend the Link-a-device hardening entry with the window, and
  say plainly what `/api/setup/status` now discloses.
- No new guide file, so no Help-page change and `check:ui` has nothing new to
  check.

---

## Stage 5 — Release

Bump all three `package.json` to `3.6.0`, add the `VERSION_UPDATES` entry in
`changelog.ts`, commit, annotated `v3.6.0` tag. Confirm the ghcr build started;
don't watch it.

---

## Verification checklist

The LAN path must be provably unchanged — this feature is an exception to it, not
a rewrite of it.

- [ ] With no window: linking from the LAN works exactly as in 3.5.0.
- [ ] With no window, from outside: the sign-in screen does not offer linking, and
      `/link` typed directly refuses with the "home network" message.
- [ ] Admin opens a window for user A. From outside, the option appears, a code is
      shown, and A approves it with their password → the device signs in.
- [ ] The window is now closed: a second device from outside is refused at approve.
- [ ] A window opened for user A does **not** let user B approve a remote request.
- [ ] Cancel closes a window immediately.
- [ ] A window expires on its own after 60 minutes and the option disappears again.
- [ ] The linked remote device is still barred from the control panel and from
      authorizing other devices.
- [ ] Admin is emailed when the remote link completes.
- [ ] `npm test`, `npm run typecheck`, `npm run check:ui`.

---

## Risks

| Risk | Mitigation |
| --- | --- |
| The probe tells the world a window is open | Bounded to a boolean with no user attached, an hour at a time; approval is still password-gated and code-matched. Stated in the docs rather than hidden. |
| `start` reachable from the internet during a window | Existing 5/min bucket, and a request that nobody with a window approves is inert — it expires in ten minutes having done nothing. |
| An admin opens a window and forgets | It closes itself in an hour, and on the first device linked. There is no way to leave one open. |
| Migration 38 against released 3.5.0 databases | Additive `ADD COLUMN` with a `PRAGMA table_info` guard and a rehearsal against a 3.5.0-schema database, as migration 37 had. |
| Scope creep into "remote device management" | Out: per-device permissions, windows for groups, self-service requests ("ask my admin"), any notion of an approved device list. |
