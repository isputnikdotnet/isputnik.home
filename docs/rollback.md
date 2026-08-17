# Rolling back a bad upgrade

When a newly released image fails to start (crash-loops) or misbehaves after an
upgrade, this is how to get back to the last known-good version quickly and
safely. Keep it short: **re-pin to the previous version's tag, restart, done** —
unless the upgrade changed the database (see below).

## How the image is tagged

The image is `ghcr.io/isputnikdotnet/isputnik.home`. Every release publishes
three tags for the same build:

- the exact version — `3.9.0`, `3.10.0`, … (immutable; this is what you roll back to)
- the minor line — `3.9`, `3.10`, … (moves within a patch line)
- `latest` — **moves to whatever was released last**

The Unraid template ships `:latest`, and most setups follow it, so right after a
release `latest` is the newest version. Rolling back means pinning to an explicit
older version tag instead of `latest`.

## Is it safe to roll back?

- **No schema change between the versions → safe, no data loss.** The older code
  reads the same database. Confirm by checking that the newer release added no
  migration (its changelog / `apps/server/src/db`). **3.10.0 ⇄ 3.9.0 is in this
  category** — no migration between them, so a rollback loses nothing.
- **The newer version added a migration → do not just re-pin.** The older image
  may not understand the upgraded database. Instead restore the automatic
  pre-upgrade backup (or a manual backup taken before the upgrade) using the
  older version. Always take/verify a backup before an upgrade for exactly this.

## Roll back to 3.9.0 (the current known-good version)

### Unraid
1. **Docker** tab → the isputnik.home container → **Edit**.
2. Change **Repository** from `…:latest` to the pinned tag:
   `ghcr.io/isputnikdotnet/isputnik.home:3.9.0`
3. **Apply.** Unraid pulls 3.9.0 and recreates the container on the same
   `/config` and media mounts. Nothing else changes.

### docker compose
```yaml
services:
  isputnik:
    image: ghcr.io/isputnikdotnet/isputnik.home:3.9.0   # was :latest
```
```bash
docker compose pull && docker compose up -d
```

### plain docker
```bash
docker pull ghcr.io/isputnikdotnet/isputnik.home:3.9.0
# stop + remove the running container, then recreate it with the SAME
# -v <appdata>:/config and media mounts, only swapping the image tag to :3.9.0
```

## After a 3.10.0 → 3.9.0 rollback (two minor, no-data-loss notes)

Only relevant if 3.10.0 actually ran for a while before you rolled back. If it
crash-looped immediately, it never wrote anything and there is nothing to redo.

- **Re-enter the SMTP password and AbuseIPDB key if you re-saved them under
  3.10.0.** 3.10.0 encrypts those two secrets at rest; 3.9.0 has no un-seal logic
  and would read the encrypted blob as the literal value. Re-type them once under
  3.9.0 (Control panel → Email settings / Security → Policies). Everything else in
  the database is plain and reads fine.
- **You may need to sign in again.** 3.10.0 renames the session cookie on HTTPS
  (`__Host-` prefix); 3.9.0 looks for the old name and simply won't find it, so it
  asks you to sign in. Harmless.

## Going forward again

Once the failing image is fixed and a corrected build is published, re-pin to the
new version (or back to `:latest`). If the failure was the non-root container
entrypoint (`scripts/docker-entrypoint.sh`, new in 3.10.0), the fix ships as
3.10.1 — roll forward to that rather than staying on 3.9.0.
