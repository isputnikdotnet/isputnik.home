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
device_name, ip_address, revoked_at
```

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
  accept 5/min; MFA verify 10/min).
- **Multi-factor authentication (TOTP)** — see below.
- **Security headers** — `@fastify/helmet` (CSP currently report-only; see
  [`users/exposing-to-the-internet.md`](users/exposing-to-the-internet.md)).
- **Scoped proxy trust** — `TRUST_PROXY_HOPS`, so a client can't spoof its IP.
- **Account lockout & IP access control** — accounts lock after 5 failed sign-ins (30 min); an IP auto-blocks after repeated failures; admins manage trusted networks (which relax rate limits, lockout, and MFA) and manual IP blocks under Control panel → Security. Engine in `core/security.ts`.
- **Suspicious-activity email alerts** — admins are emailed on lockouts, auto-blocks, a new/elevated admin, and two-factor being turned off (when SMTP is configured; `core/security-alerts.ts`).

Planned:

- CSRF tokens on mutating authenticated routes (today relies on `SameSite=Lax`).

---

## Multi-Factor Authentication (TOTP)

Optional time-based one-time-password (TOTP) second factor, compatible with Google Authenticator, Authy, Apple Passwords, and similar apps. No external service. User-facing guide: [`users/two-factor-authentication.md`](users/two-factor-authentication.md).

### Storage

```sql
users (additions)              -- migration v4
-----------------
mfa_enabled        -- 0 or 1
mfa_secret         -- TOTP secret, AES-256-GCM encrypted at rest
mfa_backup_codes   -- JSON array of sha256 hashes, single-use

mfa_challenges     -- a pending second-factor step between password and session
-----------------
id, user_id, created_at, expires_at, attempts
```

The TOTP secret is **encrypted** (not hashed) because it must be recoverable to verify codes. The key comes from `MFA_ENCRYPTION_KEY` (any string, sha256-derived to 32 bytes); if unset, a random key is persisted beside the database as `mfa.key`. Keep the key stable — changing it makes stored secrets undecryptable and forces re-enrolment (relevant when restoring a backup onto a new host). Backup codes are hashed like every other secret and consumed on use. Secret/code handling lives in `core/mfa.ts`; routes and the challenge in `core/mfa-routes.ts`.

### Login flow with MFA enabled

```
POST /api/auth/login
  → verify email + password
  → if mfa_enabled:
      create an mfa_challenges row, set a short-lived (5 min) challenge cookie
      return { mfaRequired: true }   (no session issued yet)

POST /api/auth/mfa/verify
  → resolve the challenge cookie
  → verify a TOTP code, or consume a single-use backup code
  → valid:   issue the full session, clear the challenge
  → invalid: count the attempt; after 5, destroy the challenge (re-enter password)
```

### Enrollment & recovery

- **Enroll** (Profile, password-gated): `setup` (returns the secret + a QR data URL) → `enable` (confirms a code, reveals backup codes once).
- **Manage**: turn off (password-gated) and regenerate backup codes.
- **Admin reset**: `POST /api/users/:id/mfa/reset` clears MFA for a member who lost their authenticator and backup codes — there is no email-based recovery.

### Technology

- `otplib` (v12 — the stable line; v13 is an incompatible rewrite) — TOTP generation/verification
- `qrcode` — setup QR as a data URL (Google Authenticator, Authy, Apple Passwords)
- No external service required
