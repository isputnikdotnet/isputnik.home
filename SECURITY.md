# Security Policy

iSputnik.home is a self-hosted application that holds personal family media —
photos, documents, audiobooks, and account data. It is in Beta, maintained by
one person, and security reports are taken seriously.

## Supported versions

Only the **latest release** is supported. There are no long-term support
branches and no backported fixes: if you are affected by a security issue, the
fix will land in the next release and you should upgrade to it. Your installed
version is shown in the app under **Control panel → Settings → About**.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub:

1. Go to the [Security tab](https://github.com/isputnikdotnet/isputnik.home/security)
   of this repository.
2. Choose **Report a vulnerability** and fill in the advisory form.

If that form is not available to you, open a normal issue titled
`Security contact request` containing **no details of the problem**, and you
will be invited to a private advisory to continue.

Every running instance also answers `/.well-known/security.txt` (RFC 9116, and
at the legacy `/security.txt`) with that same advisory form as its contact. It
names the project, not the household running that copy: a flaw found in
somebody's family library is a flaw in this software, and reports belong here.

### What to include

- What the flaw allows an attacker to do, and what access they need to start
  (unauthenticated? a normal user account? a share link?).
- The version from **Control panel → Settings → About**, and how the instance is deployed
  (Unraid template, `docker-compose`, or from source).
- Whether the instance is exposed to the internet, and through what — a reverse
  proxy, Cloudflare Tunnel, a direct port forward. See
  [exposing to the internet](docs/users/exposing-to-the-internet.md) for the
  configurations this project expects.
- Steps to reproduce, and a proof of concept if you have one.

### What to expect

This is a single-maintainer project, so there is no guaranteed response time.
Expect an acknowledgement within about a week. If a report is confirmed, the
fix and the release that carries it will be noted in the advisory, and you will
be credited unless you ask otherwise.

### Scope

In scope: authentication and session handling, multi-factor authentication,
the permission and library-sharing model, invite and share links, file-path
handling in the scanner and uploads, server-side request forgery in remote
image and metadata fetching, and anything that lets one user reach another
user's media.

Out of scope: findings that require an already-compromised host or an
administrator account acting against their own instance, missing hardening
headers on a deployment that ignores the documented reverse-proxy setup,
denial of service through deliberately oversized media, and vulnerabilities in
third-party dependencies that have no exploitable path in this application —
report those upstream.

## Accepted risks

Known, looked at, and deliberately left as they are for a household server's
threat model. A way to turn one of these into something worse is exactly the
kind of report worth sending.

- **`adm-zip` advisory.** `npm audit` flags `adm-zip` up to 0.6.0
  ([GHSA-vwc7-r8mq-g2x9](https://github.com/advisories/GHSA-vwc7-r8mq-g2x9):
  extracting an archive can follow a symlink at the destination and overwrite
  a file outside it). It arrives two ways, and neither extracts anything a
  user supplies. `onnxruntime-node` (face recognition) uses it in its install
  script, to unpack the runtime's own downloaded binaries. The app itself uses
  it in one place, the ebook scanner, which reads entries of an EPUB into
  memory (`getEntry(…).getData()`) and never writes an entry to disk. Backup
  restore does not use it: it reads the archive with `yauzl` and streams only
  the entries it needs to paths the server chooses — the database and the
  two-factor key to fixed names, covers only to paths that stay inside the
  thumbnail folder.
- **Path containment is lexical.** `pathIsInside`
  (`apps/server/src/modules/library/shared/storage-roots.ts`) compares resolved
  path strings; it does not resolve symbolic links. Storage containers and
  library folders are stored as real paths, and the scanners never catalogue a
  symbolic link whose target lies outside the library — but a file is checked
  again, lexically, each time it is served, so a symlink placed inside a
  library folder afterwards (or a folder swapped for one) is followed. Doing
  that takes write access to the media folders on the host, which is beyond
  what the app defends against.
- **A TOTP code can be replayed within its window.** To forgive a phone clock
  that is a little off, a code is accepted for the 30-second step before and
  after its own (`TOTP_DRIFT_SECONDS` in `apps/server/src/core/mfa.ts`), and
  the server does not remember which step was last used — so a code seen over
  someone's shoulder stays usable for up to about a minute after it appeared,
  by someone who also has the password. A sign-in challenge allows five
  attempts; passkeys have no such window.

The two reviews these came out of, and what was fixed instead, are kept in
[`docs/archive/`](docs/archive/README.md).
