# Security Remediation Plan — 2026-08-17

Consolidates two independent security passes over isputnik.home:

- **Review A** — `docs/security-review-2026-08-17.md` (API-surface + deployment review).
- **Review B** — a six-lens multi-agent audit (authn/sessions, authz/IDOR, injection/files,
  transport/headers, data-exposure, ops/supply-chain).

Both agree on the headline: **no high-severity way for an anonymous internet attacker to get in.**
Sessions, SQL parameterization, path containment, SSRF pinning, CSP, CSRF, MFA/lockout wiring, and
backup zip-slip safety were all confirmed correct by both. What remains is a set of
authorization-consistency gaps, a privacy leak to guests, deployment hardening, and dependency
patching. Threat model: a family-scale server on the public internet behind Cloudflare —
opportunistic scanners, credential stuffing, stolen passwords, malicious guests with share links.

## How the two reviews relate

| Finding | Review A | Review B | Ground-truth check |
|---|---|---|---|
| Vulnerable dependencies (sharp, fastify tree) | **High** | missed (flagged missing *cadence* instead) | ✅ `npm audit --omit=dev` = **9 high** in prod deps |
| Metadata IDOR (search/from-url/cover-candidates) | Medium | Medium (top item) | ✅ confirmed: routes have only `authenticate` |
| Guest downloads leak EXIF/GPS | missed | **Medium** | ✅ confirmed: `sendFile` streams originals raw |
| Share/invite tokens in request logs | missed | **Medium** | ✅ confirmed: serializer masks only `/opds/` |
| Trusted-net exemption lacks proxy guard | missed | **Medium** | ✅ confirmed: bare `isTrustedIp` for lockout/MFA |
| Audiobook progress IDOR | **Medium** | missed | ✅ confirmed: progress routes skip `canUserAccessBook` |
| Container runs as root | Low | Medium | ✅ confirmed: no `USER` in Dockerfile |
| Thumbnail key authorization gap | Med/Low | Low/Info | agreed |
| AbuseIPDB key echoed to admin browser | Low | Low | agreed (from the new reputation feature) |
| Guide markdown not sanitized (XSS) | Low | missed | ✅ confirmed: `dangerouslySetInnerHTML`, unescaped attrs |
| Backup/upload size uncapped | Low | Low | agreed |
| No dependabot/audit cadence | missed | Medium | complements Review A's vuln list |

Net: the union is stronger than either review alone. Nothing in one *contradicts* the other; the
only reconciliation needed was the dependency question, and running `npm audit` settled it in
Review A's favour.

---

## P0 — Do first (this batch)

### P0.1 — Patch vulnerable dependencies · *Review A · High* — ✅ DONE
`npm audit --omit=dev` reported 9 high in production deps. Resolved:
- `npm audit fix` (in-range) cleared **find-my-way** (9.6.0→9.8.0, HTTP/2 DDoS), **fast-uri**
  (3.1.2→3.1.5, host confusion), **nanoid** (5.1.11→5.1.16; the advisory only affects non-secure
  generators, which we don't use).
- **sharp** bumped `^0.34.5`→`^0.35.3` (libvips decode CVEs — matters because sharp parses untrusted
  uploads). Required a one-line type fix: sharp 0.35 moved its type namespace to named exports, so
  `sharp.OverlayOptions` → `import { type OverlayOptions }` in `gallery/slideshow-title-card.ts`.
- **@fastify/static** bumped `^9.1.3`→`^10.1.3` (auth-bypass + path-traversal route-guard-bypass —
  relevant since the SPA is served through it). Verified with a targeted boot check that our exact
  usage (register + `wildcard:false` + `setNotFoundHandler`→`sendFile`) still serves assets, the SPA
  fallback, and the `/api` JSON 404.
- **adm-zip** (direct) bumped `^0.5.17`→`^0.6.0` (crafted-ZIP 4 GB-alloc DoS — matters because the
  ebook scanner parses untrusted EPUB zips).
- **Residual (accepted):** 2 high remain, both `onnxruntime-node → adm-zip@0.5.18` (transitive). This
  is **install-time only** — onnx uses adm-zip to unpack its own prebuilt binary during `npm install`,
  never on runtime/untrusted input — and npm's only "fix" downgrades onnxruntime-node, which would
  break face recognition. Left for upstream. postcss (build-time, dev) is out of the prod tree.
- Verified: `npm audit --omit=dev` → 2 (both the residual), `npm test` (1283 server + 116 web),
  typecheck, and the full suite exercises sharp 0.35 across gallery/slideshow/thumbnail paths.
- Files: `apps/server/package.json`, lockfile, `gallery/slideshow-title-card.ts`.

### P0.2 — Fix metadata IDOR (cross-library read) · *Both · Medium — top item in both* — ✅ DONE
Implemented: a `refuseUnlessWritableBook` helper gates all four GET routes (`metadata-search`,
`metadata-from-url`, `cover-candidates`, `cover-candidate`) on write access to the book's library and
404s an inaccessible id (hides existence + blocks provider fan-out). Test `metadata-idor.test.ts`
(6 cases) covers the cross-type gallery hole and confirms a writer still gets through.
`GET /api/library/books/:id/metadata-search` (:15), `/metadata-from-url` (:45),
`/cover-candidates` (:127), `/cover-candidate` (:153) in
`apps/server/src/modules/library/audiobook/metadata-routes.ts` carry only `app.authenticate`.
`getBookCoverFolder` (`book-helpers.ts:153`) looks up **any** `library_items` row with no
library-type filter and no access check — so any signed-in member can list and download every
image in a private *gallery* folder given one item id, which per-item photo shares hand out
legitimately. Search/from-url additionally leak title/existence and issue outbound provider
requests on arbitrary ids.
- Fix: add shared helpers `requireReadableBook` / `requireWritableBook`. Require `canUserAccessBook`
  on the two read/preview routes (cover-candidates, cover-candidate) and on metadata-search
  (or `canUserWriteLibrary`, since these feed the metadata editor); require write on
  metadata-from-url. Return **404** on failure to preserve the hide-existence convention.
- Verify: a non-member gets 404 on a private book's cover-candidates; the metadata editor still
  works for a writer.
- Effort: S. Files: `metadata-routes.ts`, a new helper in `book-helpers.ts`.

### P0.3 — Stop guest photo downloads leaking EXIF/GPS · *Review B · Medium* — ✅ DONE (images)
Implemented: a `stripImageMetadata` helper (sharp `.rotate()` bakes orientation then drops all
metadata) feeds a `sendGalleryFile` dispatcher used by all five guest gallery routes (set item
file/download, single file/download, and the download-all zip). Photos go out metadata-free (format
preserved); a file sharp can't decode falls back to the original rather than 500. Test
`share-exif-strip.test.ts` proves a GPS-bearing JPEG/PNG comes back with no EXIF, still valid.
**Residual:** videos are still served as originals — stripping a video's location atom needs an
ffmpeg remux; tracked as a P1 follow-up. Images are the dominant home-GPS vector for a photo library.


The share JSON deliberately omits GPS and thumbnails are re-encoded clean, but the file download
(`sendFile`, `apps/server/src/modules/library/shared/shares.ts:540`) streams the **camera original**
— GPS (often the family home), capture timestamps, device identifiers — on `/file`, `/download`,
per-item routes, and `/download-all`.
- Fix: for **gallery** guest routes, serve a re-encoded / EXIF-stripped copy (sharp
  `.rotate().jpeg()/.webp()` drops metadata) or at minimum strip GPS tags; add an optional per-share
  "include location data" toggle for the sharer. Book/audio formats unchanged.
- Verify: download a shared photo as a guest → `exiftool` shows no GPS.
- Effort: M (streaming path + optional toggle). Files: `shares.ts`, gallery media helper.

### P0.4 — Mask share/invite tokens in request logs · *Review B · Medium* — ✅ DONE
Implemented: extracted the masking into `core/log-redaction.ts` (`maskLogUrl`) covering `/opds/`,
`/api/share/`, and `/api/invites/` tokens, wired into the pino serializer. Test `log-redaction.test.ts`
(6 cases) confirms tokens are masked, sub-paths and query strings preserved, and the owner's plural
`/api/shares/` routes are left readable.


The pino serializer (`apps/server/src/index.ts:42`) masks only `/opds/` tokens. Guest share tokens
(`/api/share/:token`, ~15 routes) and invite tokens (`/api/invites/:token`) are logged raw — anyone
with Docker logs can replay live links and unused invites (an invite grants account creation).
- Fix: extend the replace, e.g.
  `url.replace(/(\/api\/(?:share|invites)\/)[^/?]+/g, "$1<token>")` alongside the existing OPDS mask.
- Verify: a share request logs `/api/share/<token>/...`.
- Effort: S. File: `index.ts`.

---

## P1 — Do soon (same release or the next) — ✅ DONE on `security-followup`

### P1.1 — Extend the misconfigured-proxy guard to all trusted-net exemptions · *Review B · Medium* — ✅ DONE
New `isTrustedRequest(request)` in `core/security.ts` returns false when a forwarded header is present
but `TRUST_PROXY_HOPS` is 0, then falls through to `isTrustedIp`. Routed the rate-limit allowList,
the login lockout/MFA skip, the MFA-verify and passkey lockout skips, and `deletionBlocked` through
it (`deletionBlocked` now takes the request). `security.test.ts` adds `isTrustedRequest` cases and a
proxy-misconfig deletion case. Correctly configured proxies and direct-LAN installs are unaffected.

`mfaRequiredOutside` refuses to trust `request.ip` when a forwarded header is present but
`TRUST_PROXY_HOPS` is unset — but the lockout skip, enrolled-MFA skip, and rate-limit allowlist take
a bare `isTrustedIp()` (`apps/server/src/core/auth-routes.ts:36`; `index.ts:127`;
`mfa-routes.ts:540`; `webauthn-routes.ts:236`). On the target Unraid+cloudflared deploy (proxy is a
`172.16/12` Docker IP), an admin who adds their LAN as a trusted zone *and* forgets
`TRUST_PROXY_HOPS` makes the whole internet "trusted" — lockout and rate limits off.
- Fix: add a request-aware wrapper (or fold into `isTrustedIp`) that returns false when
  `hasForwardedHeader(headers) && getTrustProxyHops() === 0`, and route the four call sites through
  it. Related: document/enforce that the origin port is not directly reachable (bind 127.0.0.1 or a
  Cloudflare-peer check) so the hop-count trust can't be forged by a direct-to-origin client.
- Effort: S–M. Files: `core/security.ts`, four call sites.

### P1.2 — Run the container as non-root · *Both · Medium/Low* — ✅ DONE (needs image-build smoke test)
Implemented with a gosu-drop entrypoint (`scripts/docker-entrypoint.sh`): the image starts as root
only to make the mounted `/config` writable by `PUID:PGID` (default 1000; `99:100` on the Unraid
template), then `exec gosu` drops privileges so the Node process never runs as root. A sentinel
(`/config/.owner-uid`) runs the one-time recursive chown on first boot / uid change without a slow
every-boot pass, and handles the upgrade-from-root case where `/config` is pre-owned but its contents
aren't. `.gitattributes` pins `*.sh` to LF. Updated `docker-compose.yml`, `isputnik-home.xml`
(PUID/PGID), and the exposing-to-the-internet guide. **Not runtime-verified here — no Docker in this
environment; the shell parses clean (`sh -n`), but build the image and confirm it starts non-root and
writes `/config` on a fresh volume, an existing root-owned volume, and Unraid (99:100) before merge.**

Original finding: the final image has no `USER`; `CMD` runs as root with `/config` (DB) and, on many Unraid setups,
`/media` writable. Any RCE in the upload-parsing path (EPUB/adm-zip, sharp, ffmpeg/exifr) becomes
root with write access to the family's media.
- Fix: `USER node` in the final stage (node:22-slim ships the `node` user), `chown` `/config` in the
  `mkdir` step, document PUID/PGID for Unraid, keep media mounts `:ro`.
- Verify: container starts, writes to `/config`, streams media.
- Effort: S. Files: `Dockerfile`, `docker-compose.yml`, `isputnik-home.xml`, hosting docs.

### P1.3 — Fix audiobook progress IDOR · *Review A · Medium* — ✅ DONE
A `refuseUnlessAccessibleBook` helper (mirroring the book-detail route's `getLibraryForBook` +
`canUserAccessBook` check) gates all six playback-progress routes and 404s an inaccessible id.
`progress-idor.test.ts` confirms an outsider gets 404 on every route and writes no rows, while a
member reads and writes normally. (Reading-progress/ebook routes were already gated via
`getReadableDocument`.)

Original finding: progress read/write/delete routes (`books-routes.ts:194,
328, 435, 490, 501, 521`) act on arbitrary book ids without `canUserAccessBook`. No content bytes
leak, but a user can confirm inaccessible ids and create/update/delete their own progress rows
against them.
- Fix: resolve the book's library and require `canUserAccessBook(..., "audiobook")` before any
  progress operation; 404 on miss. (Bundles naturally with the P0.2 helper.)
- Effort: S. File: `books-routes.ts`.

### P1.4 — Add a dependency-update cadence · *Review B · Medium* — ✅ DONE
Added `.github/dependabot.yml`: weekly npm (root — covers both workspaces via the single lockfile),
github-actions, and docker updates; minor/patch grouped into one PR, majors alone for review.

Original finding:
No `dependabot.yml`/renovate and no `npm audit` in CI — P0.1's vulns accumulated silently. otplib
(MFA path) is unmaintained since ~2019; vendored foliate-js only updates via the manual VENDOR.md
procedure.
- Fix: add `.github/dependabot.yml` for `npm` (root + both workspaces), `github-actions`, and
  `docker`, weekly; optionally a scheduled `npm audit --omit=dev` CI job. Add a recurring reminder to
  re-vendor foliate-js.
- Effort: S. File: `.github/dependabot.yml`.

---

## P2 — Defense-in-depth — ✅ DONE on `security-followup`

- **Stop echoing the AbuseIPDB key to the admin browser** *(Both, Low)* — ✅ `publicSecurityPolicy`
  returns `hasAbuseIpdbKey` instead of the value; PATCH treats blank/omitted as keep. Web reputation
  card uses a password input + saved placeholder. `security-policy-key.test.ts`.
- **Authorize the thumbnail/cover store per object** *(Both, Low)* — ✅ `covers.ts` and the OPDS cover
  route gate library-bucketed keys (`LIBRARY_BUCKET_RE`) on `getAccessibleLibrary`; shared
  people/categories buckets pass through. `cover-authz.test.ts`.
- **Sanitize guide markdown** *(Review A, Low)* — ✅ `renderGuideHtml` escapes the custom renderer's
  interpolated attributes and DOMPurify-sanitizes before `dangerouslySetInnerHTML`. `GuideMarkdown.test.ts`.
- **Cap uploads and restore extraction** *(Both, Low)* — ✅ (upload cap) `resolveUploadMaxBytes` applies
  a 10 GB default when `maxUploadMB` is unset (was unlimited); UI copy updated. Restore extraction:
  the crafted-zip 4 GB-alloc DoS was already closed by the adm-zip 0.6 bump in P0.1, and restore is
  admin-only, so no further per-entry guard was added. `upload-cap.test.ts`.
- **Encrypt operator secrets in backups** *(Review B, Low)* — ✅ `sealSecret`/`openSecret` (core/mfa.ts,
  versioned `enc:v1:` prefix, fail-safe decrypt) seal the SMTP password and AbuseIPDB key at rest in
  app_settings, so the DB a backup carries is inert. Legacy plaintext reads through and re-seals on
  next save; restore on a host without `mfa.key` needs them re-entered (documented in auth.md).
  `secret-seal.test.ts`.
- **`__Host-` prefix on the session/MFA/passkey cookies** *(Review B, Low)* — ✅ `hostCookieName`
  (core/cookies.ts) prefixes the session, MFA-challenge and passkey-ceremony cookies on HTTPS. The
  session read falls back to the bare legacy name, so nobody is logged out; challenge cookies are a
  plain rename (ephemeral). `host-cookie.test.ts`. **The non-secure flows are covered by the suite;
  the `__Host-` path only engages on a real HTTPS deployment — worth a browser sign-in/MFA/passkey
  smoke test on staging before relying on it.**

### P3 — picked up after the main tiers (on `security-followup`)
- **Author-profile write gate** *(Review B, Low)* — ✅ the four `by-name` profile-write routes
  (`people.ts` PATCH, enrich, photo-from-url, PUT photo) were gated only on `authenticate`, so any
  member could rename/re-bio/re-photo any author globally. Now gated on `canWriteAnyBookLibrary`
  (mirrors gallery's `canWriteAnyGallery`); admins always pass. `author-profile-authz.test.ts`.
- **Second factor to disable MFA (and regenerate backup codes)** *(Review B, Low)* — ✅ both were
  password-only, so a stolen password + a live session could strip the second factor. Both now also
  require a current second factor (authenticator code or backup code) while MFA is on — gated
  together because a password-only backup-code regen would otherwise mint a code to disable with.
  Web disable/regenerate modals gained a code field. `mfa-disable-second-factor.test.ts`.
- **Second factor to change the login email** *(Review B, Low)* — ✅ `/api/profile/email` was
  password-only; with MFA on it now also requires a current second factor (the email is where
  email-MFA codes go, so a password-only change repoints identity + factor). Checked after the
  no-op/conflict checks so a rejected change never burns a backup code; non-MFA users are unaffected.
  Web change-email modal gained a conditional code field. `email-change-second-factor.test.ts`.

### Info / note-only (no action required for this threat model)
TOTP codes replayable within their ~60–90 s window (no last-step tracking); login-email-change is
password-gated only; scrypt at Node defaults (one notch below OWASP 2^17); backup/email codes
offline-brute-forceable only with a stolen DB; `pathIsInside` is lexical (symlink-defeatable, needs
disk access); a few exotic IPv6 ranges unblocked in the SSRF list; share-recipient endpoints return
member emails the directory withholds. Documented here for awareness; revisit only if guest accounts
become common or the threat model changes.

---

## Suggested execution

1. **Branch `security-followup`** off `main`.
2. Land P0.1–P0.4 + P1.1–P1.4 with tests (server unit tests for each IDOR/guard; a serializer test
   for token masking; an `exiftool`/metadata assertion for the guest-download strip).
3. `npm run typecheck` · `npm run check:ui` · `npm test` · `npm audit --omit=dev`.
4. Manual pass: gallery upload + thumbnail render (sharp bump), guest photo download (no GPS),
   non-member 404 on private cover-candidates, container starts as non-root.
5. Ship as a patch/minor release (changelog in `status.ts` `versionUpdates`, annotated tag).
6. Schedule P2 items into a later cleanup release.
