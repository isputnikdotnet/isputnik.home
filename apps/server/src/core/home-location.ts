import { z } from "zod";
import { db, logActivity } from "../db.js";

// Where "home" is on the map. A house's own connections have no country — they
// never leave the LAN, so no database can place them — but the household knows
// perfectly well where it lives, and a map with everything except home on it is
// a strange map. So this is one setting, typed in once by an admin, and used for
// nothing but drawing that dot.

const HOME_LOCATION_KEY = "home_location";

export const homeLocationSchema = z.object({
  latitude: z.number().min(-85).max(85),
  longitude: z.number().min(-180).max(180),
  label: z.string().trim().max(60).default("")
});

export type HomeLocation = z.infer<typeof homeLocationSchema>;

export function getHomeLocation(): HomeLocation | null {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(HOME_LOCATION_KEY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    const parsed = homeLocationSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function setHomeLocation(location: HomeLocation | null, userId: string | null): void {
  if (!location) {
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(HOME_LOCATION_KEY);
    logActivity({ event: "settings.home_location_cleared", actorUserId: userId, detail: "Cleared the home location." });
    return;
  }

  db.prepare(`
    INSERT INTO app_settings (key, value, updated_by, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(HOME_LOCATION_KEY, JSON.stringify(location), userId);

  logActivity({
    event: "settings.home_location_set",
    actorUserId: userId,
    // Coordinates are the setting itself, and this log is admin-only — but they
    // are rounded here anyway: the log says which town, not which house.
    detail: `Set the home location to ${location.latitude.toFixed(1)}, ${location.longitude.toFixed(1)}${location.label ? ` ("${location.label}")` : ""}.`
  });
}
