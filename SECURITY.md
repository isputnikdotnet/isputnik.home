# Security Policy

iSputnik.home is a self-hosted application that holds personal family media —
photos, documents, audiobooks, and account data. Security reports are taken
seriously even though this is an experimental personal project.

## Supported versions

Only the **latest release** is supported. There are no long-term support
branches and no backported fixes: if you are affected by a security issue, the
fix will land in the next release and you should upgrade to it. Your installed
version is shown in the app under **Control panel → About**.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub:

1. Go to the [Security tab](https://github.com/isputnikdotnet/isputnik.home/security)
   of this repository.
2. Choose **Report a vulnerability** and fill in the advisory form.

If that form is not available to you, open a normal issue titled
`Security contact request` containing **no details of the problem**, and you
will be invited to a private advisory to continue.

### What to include

- What the flaw allows an attacker to do, and what access they need to start
  (unauthenticated? a normal user account? a share link?).
- The version from **Control panel → About**, and how the instance is deployed
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
