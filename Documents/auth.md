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

## Planned Hardening

- CSRF protection on mutating authenticated routes
- Rate limiting on login, invite acceptance, and future recovery flows
- Session ID rotation for any future multi-step authentication flow

---

## MFA — Future Update

TOTP-based multi-factor authentication. Implementation is deferred until the core content milestones (Digital Library, Notes) are stable.

### Database additions

```sql
users (additions)
-----------------
mfa_enabled           -- 0 or 1
mfa_secret_encrypted  -- encrypted TOTP secret, set during MFA setup
mfa_backup_codes      -- JSON array of hashed single-use recovery codes
```

### Login flow with MFA enabled

```
POST /api/auth/login
  → verify email + password
  → if mfa_enabled:
      issue short-lived mfa_pending cookie (5 min)
      return { mfaRequired: true }
  → frontend shows 6-digit code entry

POST /api/auth/mfa/verify
  → validate mfa_pending cookie
  → verify TOTP code (or backup code) against stored secret
  → if valid: create full session, clear mfa_pending cookie
  → if invalid: increment attempt counter (lock after 5 failures)
```

### Backup recovery codes

Generated during MFA setup, shown once, stored as hashed values. Single-use — consumed on successful use. A new set can be regenerated from the profile security screen.

### Technology

- `otplib` — TOTP generation and verification
- `qrcode` — QR code for authenticator app setup (Google Authenticator, Authy, Apple Passwords)
- No external service required
