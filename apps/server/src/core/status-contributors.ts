// The registry behind /api/status's per-media-type numbers.
//
// core/ is platform infrastructure: it may know that media types exist and that
// some of them have something to report, but never what an audiobook or a photo
// is. The status route used to hold the SQL for all three types directly, which
// meant every new media type edited core/ — exactly what the architecture rule
// in CLAUDE.md exists to prevent.
//
// So the dependency is inverted. core owns this registry and the route that
// drains it; each media type registers its own contributor from its own plugin
// (see modules/library/<type>/stats.ts) and keeps its own SQL. Adding a media
// type now touches only that type's directory.
//
// A contributor returns a flat object that is spread into the status payload,
// so one type can own several top-level keys (gallery supplies both galleryStats
// and faceStats). Keys must not collide between types; registering the same key
// twice throws at startup rather than letting one type silently shadow another.

export type StatusContributor = () => Record<string, unknown>;

const contributors = new Map<string, StatusContributor>();

/**
 * @param name  the contributing module, for error messages only
 * @param keys  the top-level status keys this contributor owns
 */
export function registerStatusContributor(
  name: string,
  keys: readonly string[],
  contribute: StatusContributor
): void {
  for (const key of keys) {
    const existing = contributors.get(key);
    if (existing && existing !== contribute) {
      throw new Error(`Status key "${key}" is already claimed by another module (registering "${name}").`);
    }
  }
  for (const key of keys) contributors.set(key, contribute);
}

/**
 * Every registered contributor's numbers, merged. Called per request — the
 * counts are live, and nothing here is cached.
 *
 * A contributor that throws must not take the whole status page down with it:
 * a half-migrated database or a media type mid-scan should cost you that type's
 * panel, not the users/sessions/disk figures an admin came to read. The failing
 * keys are simply absent, which the client already renders as "no data".
 */
export function collectStatusContributions(log?: { warn: (msg: string) => void }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const contribute of new Set(contributors.values())) {
    try {
      Object.assign(out, contribute());
    } catch (err) {
      log?.warn(`A status contributor failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/** Test seam: drop every registration so a suite can register its own. */
export function resetStatusContributors(): void {
  contributors.clear();
}
