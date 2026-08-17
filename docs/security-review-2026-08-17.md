# Security Review - 2026-08-17

This review inspected the API surface and supporting implementation for:

- Unauthenticated and authenticated endpoints
- Admin versus normal-user enforcement
- File upload/download handling and path traversal
- Library isolation, IDOR, and object authorization
- SSRF from metadata, cover, and image URLs
- SQL injection and XSS/stored XSS
- Authentication cookies, API tokens, session expiry, and revocation
- Password storage, MFA, passkeys, and QR/device login
- Rate limiting and reverse-proxy/IP-header trust
- Docker permissions and mounted filesystem exposure
- Secrets/API keys
- Security headers, CORS, and dependency vulnerabilities

## Findings

### High: Vulnerable Dependencies

`npm audit --json` reported 11 high-severity vulnerabilities.

Relevant direct dependencies include:

- `apps/server/package.json:21` - `@fastify/static` `^9.1.3`
- `apps/server/package.json:23` - `adm-zip` `^0.5.17`
- `apps/server/package.json:31` - `nanoid` `^5.1.5`
- `apps/server/package.json:33` - `onnxruntime-node` `^1.27.0`
- `apps/server/package.json:37` - `sharp` `^0.34.5`
- `package.json:24` - `concurrently` `^9.1.2`
- `package.json:29` - `shell-quote` override `^1.8.4`

The `@fastify/static` advisories are particularly relevant because static serving is registered in `apps/server/src/index.ts:222`.

Recommended remediation:

- Upgrade direct dependencies with available fixes.
- Revisit the `shell-quote` override.
- Re-run `npm audit` after dependency changes.
- Smoke-test static file serving, image processing, audiobook/ebook scanning, and startup.

### Medium: Audiobook Metadata IDOR

Several authenticated audiobook metadata routes use a book ID without first checking whether the current user can access the book or its library:

- `apps/server/src/modules/library/audiobook/metadata-routes.ts:15` - metadata search
- `apps/server/src/modules/library/audiobook/metadata-routes.ts:45` - metadata from URL
- `apps/server/src/modules/library/audiobook/metadata-routes.ts:127` - cover candidates
- `apps/server/src/modules/library/audiobook/metadata-routes.ts:153` - cover candidate download

Impact:

Any signed-in user who knows or guesses another audiobook item ID may be able to infer item existence, title/metadata, and cover-candidate image data from a private or otherwise inaccessible library.

Recommended remediation:

- Add a shared helper such as `requireReadableBook` and `requireWritableBook`.
- Require `canUserAccessBook` for read/search/list/preview metadata operations.
- Require write/library-manager permission for metadata and cover mutations.
- Return `404` for inaccessible IDs to avoid object enumeration.

### Medium: Audiobook Progress IDOR

Audiobook progress routes read or mutate progress for arbitrary book/file IDs without first enforcing access to the audiobook item:

- `apps/server/src/modules/library/audiobook/books-routes.ts:194`
- `apps/server/src/modules/library/audiobook/books-routes.ts:328`
- `apps/server/src/modules/library/audiobook/books-routes.ts:435`
- `apps/server/src/modules/library/audiobook/books-routes.ts:490`
- `apps/server/src/modules/library/audiobook/books-routes.ts:501`
- `apps/server/src/modules/library/audiobook/books-routes.ts:521`

Impact:

This does not appear to expose media bytes, but it lets authenticated users confirm inaccessible object IDs and create, update, or delete their own progress rows for books they should not be able to access.

Recommended remediation:

- Before any progress read/write/delete, resolve the book's library.
- Require `canUserAccessBook(bookId, library, user.id, user.role, "audiobook")`.
- Return `404` for missing or inaccessible books.

### Medium/Low: Thumbnail Key Authorization Gap

Raw thumbnail/cover key routes authenticate the account or OPDS token but do not authorize the underlying object:

- `apps/server/src/modules/library/covers.ts:20`
- `apps/server/src/modules/library/ebook/opds.ts:363`
- `apps/server/src/modules/library/shared/thumbnail.ts:45`

Path traversal is blocked by thumbnail-root containment checks, and keys are opaque. However, if a storage key leaks, any authenticated account or valid OPDS token can fetch that thumbnail without checking the corresponding library/item permissions.

Recommended remediation:

- Prefer object-scoped cover endpoints that resolve the item/person/category first.
- Apply library/object authorization before reading the thumbnail.
- Alternatively, issue short-lived signed cover URLs scoped to the requesting user.

### Low: AbuseIPDB Key Returned To Admin Browser

The security policy includes `abuseIpdbKey` in `apps/server/src/core/security.ts:19`, and `/api/security` returns the full policy object from `apps/server/src/core/security-routes.ts:56`.

Impact:

This is admin-only, but it exposes a secret to browser JavaScript, extensions, logs, devtools, and any future admin-page XSS.

Recommended remediation:

- Follow the SMTP configuration pattern.
- Return `hasAbuseIpdbKey` instead of the key value.
- Accept a new key only when the admin explicitly submits one.

### Low: Docker Runs As Root With Writable Config Volume

The final Docker image does not set a non-root `USER`. Sensitive app data is stored under `/config`:

- `Dockerfile:127`
- `docker-compose.yml:20`

The default compose file mounts media read-only, which is good, but `/config` remains writable by the root-running process.

Recommended remediation:

- Create and run as a non-root user.
- Document UID/GID ownership requirements for `/config`.
- Keep media mounts read-only by default.
- Consider binding the app port to `127.0.0.1` when it is intended to run only behind a reverse proxy.

### Low: Guide Markdown Rendering Is Not Sanitized

`apps/web/src/pages/GuidePage.tsx:43` custom-renders markdown and injects it through `dangerouslySetInnerHTML` at `apps/web/src/pages/GuidePage.tsx:94`.

Current exploitability appears low because the markdown files are shipped with the app, not user-controlled. If those guides ever become editable, remotely sourced, or generated from user input, this becomes an XSS risk.

Recommended remediation:

- Sanitize rendered markdown with a library such as DOMPurify.
- Escape generated attributes in the custom renderer.
- Disable raw HTML if the guide feature does not need it.

### Low: Backup Upload And Restore Are Uncapped

Admin backup upload uses `maxBytes: null` in `apps/server/src/modules/backups/index.ts:437`. Restore extraction does not appear to enforce a total uncompressed-size limit.

Impact:

This is admin-only, but a compromised admin account or careless restore can exhaust disk space under the configured data volume.

Recommended remediation:

- Add a configurable maximum upload size.
- Track total extracted bytes and entry count during restore.
- Abort extraction when configured limits are exceeded.

## Areas That Looked Solid

### Public Endpoints

Unauthenticated routes are mostly limited to login, first-run setup, MFA/passkey challenge verification, device-link start/poll, invite acceptance, public share links, OPDS token access, and `security.txt`.

Sensitive public endpoints are rate-limited, tokenized, or gated by setup state.

### Authentication And Sessions

Session tokens are generated with high entropy, stored server-side as SHA-256 hashes, and sent in HttpOnly cookies with SameSite=Lax. Sessions require `revoked_at IS NULL`, `expires_at > CURRENT_TIMESTAMP`, and an active user.

Logout revokes the current session. API tokens are hashed at rest and returned only once at creation.

### Admin Enforcement

`requireAdmin` authenticates first, rejects device sessions, and then requires `user.role === "admin"`.

### File Handling And Path Traversal

The reviewed upload and stream paths consistently use basename sanitization, configured storage roots, `realpath`, and `pathIsInside` containment checks. Document, gallery, and audiobook media streaming routes generally authorize the object before reading files.

### SSRF

Arbitrary user-provided cover/image URL fetching uses DNS resolution, blocks private and local IP ranges, pins the resolved address, limits redirects, restricts protocols to HTTP/HTTPS, and enforces size/time limits.

Provider metadata fetches are either fixed-host or allowlisted.

### SQL Injection

Reviewed SQL access uses prepared statements and bound parameters. Dynamic `IN` clauses are constructed with generated placeholders, and dynamic sort/order clauses are selected from allowlisted maps.

### XSS

Most application data is rendered through React's normal escaping. No obvious API-backed stored XSS path was found outside the guide markdown hardening note.

### Rate Limiting And Proxy Trust

Global and per-route rate limits are present. Reverse-proxy trust is opt-in through configured hop counts, and forwarded headers seen without proxy trust produce warnings. Device-link local-network checks account for proxy trust state.

### QR/Device Login

Device codes are high entropy and hashed at rest. User codes are short-lived. Approval requires an authenticated browser session and current password. Device sessions cannot approve new devices and cannot use admin routes.

### Security Headers And CORS

CORS is restricted to the configured app origin with credentials enabled. Helmet is configured with a restrictive CSP, `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'self'`, and HSTS when HTTPS is configured.

## Verification

Commands run during review:

- `npm run typecheck` - passed
- `npm run check:ui` - passed
- `npm audit --json` - failed with 11 high-severity vulnerabilities
