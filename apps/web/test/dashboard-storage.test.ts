import { describe, expect, it } from "vitest";
import { driveBreakdown } from "../src/features/control/sections/dashboard/storageBreakdown";
import type { OwnedDisk } from "../src/features/control/sections/dashboard/useDashboardOverview";

// What uses a drive (control panel v2, phase 4): each place counts only what is
// not another place's, libraries by their scanned size, and the rest of the used
// space is "Other files" rather than being shared out among the categories.

const GB = 1_000_000_000;

function drive(holds: OwnedDisk["holds"]): OwnedDisk[] {
  return [{ mount: "/config", filesystem: "1", freeBytes: 0, totalBytes: 100 * GB, holds, sharesWith: [], owner: "home" }];
}

describe("driveBreakdown", () => {
  it("takes nested places out of the folder that holds them", () => {
    const result = driveBreakdown(drive([
      { kind: "database", path: "/config", bytes: 1 * GB },
      { kind: "systemData", path: "/config/data", bytes: 30 * GB },
      { kind: "thumbnails", path: "/config/data/thumbnails", bytes: 20 * GB },
      { kind: "backups", path: "/config/data/backups", bytes: 5 * GB }
    ]), new Map(), 60 * GB);
    // System data's own is 30 − 20 − 5; the database is its own files, so the
    // folder it sits in is not subtracted from or added to.
    expect(result.categories).toEqual({ appData: 6 * GB, thumbnails: 20 * GB, backups: 5 * GB });
    expect(result.other).toBe(29 * GB);
    expect(result.measuring).toBe(false);
  });

  it("subtracts only direct children, not grandchildren twice", () => {
    const result = driveBreakdown(drive([
      { kind: "appFiles", path: "/media/app", bytes: 10 * GB },
      { kind: "library", id: "inbox", name: "Inbox", path: "/media/app/inbox" },
      { kind: "trash", path: "/media/app/inbox/.trash", bytes: 1 * GB }
    ]), new Map([["inbox", 4 * GB]]), 20 * GB);
    expect(result.categories).toEqual({ appData: 6 * GB, media: 4 * GB, trash: 1 * GB });
    expect(result.other).toBe(9 * GB);
  });

  it("says so while a folder is still being counted, and never makes other negative", () => {
    const result = driveBreakdown(drive([
      { kind: "thumbnails", path: "/t", bytes: null },
      { kind: "backups", path: "/b", bytes: 50 * GB, partial: true },
      { kind: "library", id: "unscanned", name: "New", path: "/m" }
    ]), new Map(), 10 * GB);
    expect(result.measuring).toBe(true);
    expect(result.categories).toEqual({ backups: 50 * GB });
    expect(result.other).toBe(0);
  });
});
