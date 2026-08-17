#!/bin/sh
# Run the server unprivileged. The image starts as root only long enough to make
# the mounted /config volume writable by the runtime user, then drops privileges
# with gosu — so the Node process, which parses untrusted uploads (images via
# sharp, EPUB zips via adm-zip, media via ffmpeg), never runs as root. An RCE in
# any of those then lands as an ordinary user, not root with write access to the
# whole media share.
#
# PUID/PGID choose the runtime user. Default 1000 (the image's `node` user) suits
# a plain docker/compose host; on Unraid set them to the appdata share's owner
# (usually 99:100). If an operator instead runs the container with a compose
# `user:` (so we start unprivileged), we skip the chown and exec directly.
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u)" = "0" ]; then
  # These must exist inside the mounted volume, not just the image, or the server
  # writes into a directory the host never sees (see the ENV notes in Dockerfile).
  mkdir -p /config/db /config/thumbnails /config/metadata /config/backups
  # Always fix ownership of the top-level dirs we just (re)created — cheap, and it
  # covers the case where an operator cleared a cache dir (e.g. rm -rf the
  # thumbnails) and restarted: mkdir recreates it root-owned, and the whole-tree
  # sentinel below would otherwise skip it, leaving it unwritable by the dropped user.
  chown "${PUID}:${PGID}" /config /config/db /config/thumbnails /config/metadata /config/backups
  # Take the whole-tree ownership pass once per PUID:PGID, tracked by a sentinel
  # we write. A plain top-level check is not enough: upgrading from a root-run
  # image can leave /config itself owned correctly (Unraid pre-creates it) while
  # the files inside are still root-owned and unwritable by the dropped user.
  mark="/config/.owner-uid"
  if [ "$(cat "$mark" 2>/dev/null)" != "${PUID}:${PGID}" ]; then
    chown -R "${PUID}:${PGID}" /config
    printf '%s:%s' "$PUID" "$PGID" > "$mark"
  fi
  exec gosu "${PUID}:${PGID}" "$@"
fi

exec "$@"
