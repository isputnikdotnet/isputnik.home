# Authentication

Session-based authentication using secure `httpOnly` cookies. Simpler than JWT for a single-server home app, with straightforward session revocation.

---

## Session Management

Sessions are stored in SQLite and identified by a hashed cookie token. The raw token never appears in the database — only its SHA-256 hash is stored.

```sql
sessions
--------
id, user_id, created_at, expires_at, last_seen,
token_hash,
device_name, ip_address, revoked_at,
kind,           -- 'browser' | 'device'  (migration v37)
label           -- owner-given name for a linked device
```

`kind` separates a session someone signed into here from one minted by linking a
display (see below). A `device` session lives for `DEVICE_SESSION_DAYS` (365)
rather than `SESSION_DAYS` (14), and `requireAdmin` refuses it outright whatever
the account's role — so a screen in a hallway is never a way into the control
panel. `/api/auth/me` reports the kind, and the SPA hides admin UI for a device
session rather than offering a control panel that answers 403 to everything.

Session cookies are configured with:

- `HttpOnly` — client-side JavaScript cannot read the token
- `Secure` in production — only sent over HTTPS
- `SameSite=Lax`
- Configurable expiry backed by the SQLite session record

**Session lifecycle:**

- Created on successful login or invite acceptance
- Refreshed (`last_seen`) on each authenticated request
- Revoked on logout, account deactivation, or by an admin from the control panel
- Expired sessions are never purged automatically — they are ignored by the auth check

---

## Login Flow

```
POST /api/auth/login
  → validate email + password (scrypt)
  → on failure: log auth.login_failed, return 401
  → on success: create session record, set cookie, return user
```

Passwords are hashed with Node.js `scrypt`. The salt is embedded in the stored hash (same format as bcrypt). `verifyPassword` extracts the salt and recomputes.

---

## Invite-Only Registration

No public sign-up. Admins generate a single-use invite link from the control panel. Only the token's SHA-256 hash is stored — the raw token is **never persisted**. The link is shown once, at creation; it cannot be re-displayed later, so the control panel list offers no copy action for existing invites (delete and recreate to get a new link). This mirrors how share links are handled.

The invite URL is built from the request's `Origin` (the address the admin is actually using), falling back to the configured `APP_URL` — so links point at the real site instead of a hardcoded default.

```sql
invites
-------
id, token_hash,
role,
created_by, created_at,
expires_at, used_at, used_by,
revoked_at
```

**Invite lifecycle:**

- Created by admin with a role (`admin` or `member`) and configurable expiry; the link is shown once on creation
- Link is single-use — `used_at` is set on acceptance
- Admins can revoke pending invites at any time (`revoked_at`)
- Accepting an invite creates a user account and a session in the same transaction

---

## Users Table

```sql
users
-----
id, email, password_hash, display_name,
role,           -- 'admin' | 'member'
theme,          -- 'system' | 'light' | 'dark'
protected_from_delete,
is_active,
created_at, updated_at, deleted_at
```

`protected_from_delete` is set only on the initial setup-admin account and prevents deletion or role change from the control panel.

---

## Route Guards

Two Fastify preHandlers enforce access:

- `app.authenticate` — requires a valid, non-expired session cookie
- `app.requireAdmin` — requires `authenticate` + `role === 'admin'`

---

## Hardening status

Shipped:

- **Rate limiting** — a generous global per-IP limit, with tight limits on the
  sensitive endpoints (login and admin setup 10/min; invite lookup 20/min, invite
  accept 5/min; MFA verify 10/min). The public guest-share routes — the only ones
  reachable without an account — carry their own buckets sized per shape (page
  120/min, thumbnails 1200/min, media/range requests 600/min, whole-album zip
  10/min). The token can't be guessed, so this bounds what a *leaked* link can cost.
- **Not indexable** — every response carries `X-Robots-Tag: noindex, nofollow`,
  backed by a disallow-all `robots.txt` and a `robots` meta tag in the app shell.
  This matters most for guest share links: unlisted by design, and otherwise liable
  to outlive their own revocation inside a search index.
- **Reportable** — `/.well-known/security.txt` (and the legacy `/security.txt`)
  answer per RFC 9116, pointing at the upstream project's security advisories
  rather than the operator: a flaw here is a flaw in the software, and the
  household running a copy usually can't fix it. `Expires` is computed per request
  (`core/security-txt.ts`), so no installation ever serves a stale one.
- **Multi-factor authentication** — an authenticator app (TOTP) or emailed codes, per user's choice. See below.
- **Security headers** — `@fastify/helmet` with an enforced CSP tailored to the app, plus no-sniff, frame-ancestors, `form-action 'self'` (so injected markup can't post to an attacker's host), and a no-referrer policy.
- **CSRF protection** — a double-submit `isputnik_csrf` token validated on every state-changing request (`core/csrf.ts`), layered on `SameSite=Lax`. Where the
  cookie can carry `Secure` (HTTPS) it's issued under the `__Host-` prefix, which
  pins it to the exact origin and stops a sibling subdomain overwriting it; a
  plain-http LAN deployment keeps the bare name, because a browser rejects that
  prefix without `Secure` and every mutation would 403. The SPA prefers the
  prefixed cookie, so both can coexist across an upgrade (`csrfCookieName`).
- **No account-existence oracle on login** — an unknown or deactivated email is
  still checked against a dummy hash (`verifyDummyPassword`), so a miss can't be
  told from a wrong password by how long the answer takes. scrypt is slow enough
  that returning early would otherwise be plainly measurable.
- **Configurable password policy** — admin-tunable minimum length and optional complexity, enforced on every password-set flow but not on login (`core/password-policy.ts`).
- **Scoped proxy trust** — `TRUST_PROXY_HOPS`, so a client can't spoof its IP.
- **Account lockout & IP access control** — accounts lock after repeated failures (defaults: 5 fails / 30 min); an IP auto-blocks after repeated failures; admins manage trusted networks (which relax rate limits, lockout, and MFA), manual IP blocks, and the configurable thresholds under Control panel → Security. Engine in `core/security.ts`.
  A **rejected second factor counts as a failed attempt** alongside a rejected
  password, so guessing codes locks the account and auto-blocks the IP on the same
  thresholds. That only works because the password step of an MFA sign-in records
  *nothing*: a success row there would clear the tally (it counts back to the last
  success), letting a caller who knows the password reset the lockout between code
  guesses. The success is recorded when the second factor completes, and reaching
  the lock mid-challenge destroys the live challenge so its remaining per-challenge
  attempts can't be spent. `accountFailureCount` draws the "since the last success"
  line on rowid rather than the timestamp — millisecond ties would otherwise drop
  failures from the count.
- **Scan resistance beyond the login route** — the per-IP auto-block used to see
  only failed sign-ins, so a scanner sweeping the rest of the surface met no
  consequence. Two more things now count against the source IP (`flagAbusiveRequest`):
  requests for known scanner probe paths (`core/probes.ts` — `*.php`, `/.env`,
  `/.git/…`, `/wp-admin`, `/phpmyadmin`, …), which are answered with a bare 404
  ahead of CSRF, auth, and the SPA fallback; and share or OPDS tokens that match
  **no** row at all. A token that matches a link which is merely expired or revoked
  is deliberately not counted — that's a stale family bookmark or an e-reader
  holding an old token, and blocking the household for it would be its own outage.
  Anonymous hits are stored with a NULL email so they can only ever feed the
  per-IP block, never an account lockout, and trusted networks are exempt.
- **Suspicious-activity email alerts** — admins are emailed on lockouts, auto-blocks, a new/elevated admin, and two-factor being turned off (when SMTP is configured; `core/security-alerts.ts`).
- **Account-security change alerts** — the account owner is emailed when the login
  email changes (both the old and the new address, since the old one is the only
  side that can still object), when the password changes (with different copy for
  a self-serve change and an admin reset), when two-factor is switched **on**, and
  when backup codes are regenerated. These are the four moves that lock a real
  owner out of their own account. Each is throttled to one per 10 minutes.
- **Repeated two-factor failure alerts** — three rejected codes for one account
  within 15 minutes emails the owner and the admins. Reaching the code step means
  the password was accepted, so this is the clearest signal available that a
  credential is known to someone else. Counted off the `auth.mfa_failed` activity
  log rows (`recentMfaFailureCount`), so there's no extra table and the tally
  survives a restart; one alert per 15-minute window.
- **New-network sign-in alerts** — opt-in (Control panel → Security → Policies). A
  successful sign-in from a network the account has never used emails both the
  account owner and the admins. Networks are matched on the /24 (IPv4) or /64
  (IPv6) so rotating home/mobile addresses don't alert on every reconnect, and
  sign-ins from trusted networks never alert. Every sign-in records its network in
  `known_login_networks` regardless of the setting, and enabling the alert seeds
  that table from sign-in history, so switching it on doesn't fire for devices
  already in use. First sight of a network is also written to the activity log
  (`auth.new_network`) whether or not email is on.

- **Link a device** — signing a TV, wall display or kiosk in by scanning a QR code
  with a phone that is already signed in, rather than typing a password with a
  remote control (`core/device-link.ts`, `core/device-link-routes.ts`). The OAuth
  2.0 device-authorization shape, narrowed to one household. The attack this grant
  type invites is a stranger starting a request remotely and talking a household
  member into approving it, so four things answer it: the request is refused
  outright unless it comes from the home network (`deviceLinkScope`, default
  `local`, admin-tunable); the QR carries no approval — it opens a confirmation
  screen showing the code to be compared against the screen across the room;
  approving is password-gated like enrolling a second factor; and the owner is
  emailed every time one is linked. A linked display cannot open the control panel
  or authorize further devices. Behind a proxy with `TRUST_PROXY_HOPS` unset,
  `request.ip` is the proxy — every device would look local — so linking refuses
  entirely in that state rather than degrading to "anyone at all". User-facing
  guide: [`users/link-a-device.md`](users/link-a-device.md).
- **Self-service sessions** — `/api/account/sessions` lets each user see, rename
  and revoke their own sign-ins (Profile → Devices). `/api/sessions` remains the
  admin's view of everyone's.

Planned:

- Optional "require MFA for admins" enforcement (MFA is opt-in today).

---

## Multi-Factor Authentication

Optional second factor, in one of two **mutually exclusive** methods the user picks at enrollment (`users.mfa_method`):

- **`totp`** — a time-based one-time password from Google Authenticator, Authy, Apple Passwords, and similar apps.
- **`email`** — a 6-digit code mailed to the address the account signs in with, over the server's own SMTP settings (Control panel → Settings → Email). Offered only when `isMailConfigured()`.

Neither needs an external service. Backup codes rescue either. User-facing guide: [`users/two-factor-authentication.md`](users/two-factor-authentication.md).

Email is the **weaker** method — the code crosses the internet in plaintext, anyone holding the mailbox holds the factor, and it stops working if SMTP does. It exists because "I lost my authenticator" is the most common way a household member locks themselves out. The Profile chooser says as much, ranks TOTP first, and disables the option when the server can't send mail.

### Storage

```sql
users (additions)
-----------------
mfa_enabled        -- 0 or 1
mfa_method         -- 'totp' | 'email'  (migration v24)
mfa_secret         -- TOTP secret, AES-256-GCM encrypted at rest; NULL for 'email'
mfa_backup_codes   -- JSON array of sha256 hashes, single-use

mfa_challenges     -- a pending second-factor step between password and session
-----------------
id, user_id, purpose, created_at, expires_at, attempts,
code_hash, sends, last_sent_at            -- the last three: 'email' only
```

The TOTP secret is **encrypted** (not hashed) because it must be recoverable to verify codes. The key comes from `MFA_ENCRYPTION_KEY` (any string, sha256-derived to 32 bytes); if unset, a random key is persisted beside the database as `mfa.key`. Keep the key stable — changing it makes stored secrets undecryptable and forces re-enrolment (relevant when restoring a backup onto a new host).

Emailed codes need no such key: each is minted per challenge and stored **hashed** (`code_hash`), like a backup code, so a stolen database yields nothing replayable. `purpose` lets the same row shape serve both a sign-in (`login`) and the code that confirms an email enrollment (`enroll`) — one row per user per purpose. Secret/code handling lives in `core/mfa.ts`; routes and the challenge in `core/mfa-routes.ts`.

### Login flow with MFA enabled

```
POST /api/auth/login
  → verify email + password
  → if mfa_enabled:
      create an mfa_challenges row, set a challenge cookie
        (5 min for totp; 10 min for email — a mail has to arrive first)
      if method = email: mail the code, fire-and-forget (a dead SMTP host
        must not stall the sign-in; the reply carries emailSent so the UI can
        point at backup codes instead)
      return { mfaRequired: true, method, sentTo? }   (no session issued yet)

POST /api/auth/mfa/resend            -- email method only
  → 60s cooldown, 3 sends per challenge, expiry NOT extended
  → mints a new code and retires the previous one

POST /api/auth/mfa/verify
  → resolve the challenge cookie
  → verify the code for the account's method, or consume a single-use backup code
  → valid:   issue the full session, clear the challenge
  → invalid: count the attempt; after 5, destroy the challenge (re-enter password)
```

Only the "is this code correct?" line branches on the method — the attempt cap, account lockout, per-IP auto-block, and alerting are shared, so the email path inherits all of it unchanged.

### Enrollment & recovery

- **Enroll** (Profile, password-gated): `setup` (TOTP: the secret + a QR data URL; email: mails a code to the account address and returns the masked recipient) → `enable` (confirms a code, reveals backup codes once). Nothing is switched on until the factor is proven to reach the user.
- **Manage**: turn off (password-gated) and regenerate backup codes. Switching methods = turn off, set up again.
- **Admin reset**: `POST /api/users/:id/mfa/reset` clears MFA — method, secret, and backup codes — for a member locked out of their second factor. There is no self-service recovery.

### Technology

- `otplib` (v12 — the stable line; v13 is an incompatible rewrite) — TOTP generation/verification
- `qrcode` — setup QR as a data URL (Google Authenticator, Authy, Apple Passwords)
- `nodemailer`, via the shared `core/mail.ts` SMTP settings — delivery for emailed codes
- No external service required
