// The one coordinate a household types in itself. It exists because a LAN address
// has no country to look up — so without it the Locations map draws everyone
// except the people who own the server.
import { beforeEach, describe, expect, it } from "vitest";
import { getHomeLocation, homeLocationSchema, setHomeLocation } from "../src/core/home-location.js";
import { db } from "../src/db.js";
import { makeUser, resetDb } from "./helpers/seed.js";

let admin = "";

beforeEach(() => {
  resetDb();
  admin = makeUser("boss", "admin");
});

describe("home location", () => {
  it("is unset until someone sets it", () => {
    expect(getHomeLocation()).toBeNull();
  });

  it("round-trips a coordinate and its name", () => {
    setHomeLocation({ latitude: 53.9006, longitude: -1.5406, label: "The house" }, admin);
    expect(getHomeLocation()).toEqual({ latitude: 53.9006, longitude: -1.5406, label: "The house" });
  });

  it("can be taken back off the map", () => {
    setHomeLocation({ latitude: 53.9, longitude: -1.5, label: "" }, admin);
    setHomeLocation(null, admin);
    expect(getHomeLocation()).toBeNull();
  });

  it("logs both, so the change is visible in the activity log", () => {
    setHomeLocation({ latitude: 53.9006, longitude: -1.5406, label: "The house" }, admin);
    setHomeLocation(null, admin);
    const events = (db.prepare("SELECT event, detail FROM activity_logs ORDER BY rowid").all() as { event: string; detail: string }[]);
    expect(events.map((row) => row.event)).toEqual(["settings.home_location_set", "settings.home_location_cleared"]);
    // Rounded in the log — it says which town, not which house.
    expect(events[0].detail).toContain("53.9, -1.5");
  });

  it("refuses coordinates that are not on the map", () => {
    expect(homeLocationSchema.safeParse({ latitude: 91, longitude: 0 }).success).toBe(false);
    expect(homeLocationSchema.safeParse({ latitude: 0, longitude: 181 }).success).toBe(false);
    expect(homeLocationSchema.safeParse({ latitude: "north", longitude: 0 }).success).toBe(false);
    expect(homeLocationSchema.safeParse({ latitude: 0, longitude: 0 }).success).toBe(true);
  });

  it("ignores a stored value that has gone bad rather than crashing the page", () => {
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('home_location', 'not json')").run();
    expect(getHomeLocation()).toBeNull();
  });
});
