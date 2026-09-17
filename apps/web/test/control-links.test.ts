import { beforeEach, describe, expect, it } from "vitest";
import { getRoute } from "../src/router";
import { blockIpHref, initialParam, libraryRowHref, logsHref, recycleBinHref, storageHref, tasksHref } from "../src/features/control/links";

// The links between control pages carry their narrowing in the address. Each must
// still resolve to the page it names (the router reads the path only), and leave
// out what wasn't given rather than writing "library=undefined".
const at = (url: string) => window.history.replaceState({}, "", url);

beforeEach(() => at("/"));

describe("control page links", () => {
  it.each([
    [tasksHref({ library: "lib1" }), "/control/maintenance/tasks?library=lib1", "tasks"],
    [tasksHref({ library: undefined, type: "SCAN_GALLERY_DUPLICATES" }), "/control/maintenance/tasks?type=SCAN_GALLERY_DUPLICATES", "tasks"],
    [tasksHref(), "/control/maintenance/tasks", "tasks"],
    [recycleBinHref({ source: "duplicate_cleanup", library: undefined }), "/control/maintenance/recycle-bin?source=duplicate_cleanup", "recycleBin"],
    [logsHref({ ip: "203.0.113.9" }), "/control/overview/logs?ip=203.0.113.9", "logs"],
    [logsHref({ user: "acct_123" }), "/control/overview/logs?user=acct_123", "logs"],
    [blockIpHref("203.0.113.9"), "/control/security/blocked-ips?block=203.0.113.9", "securityBlocked"],
    [libraryRowHref("lib1"), "/control/libraries#library-lib1", "libraries"],
    [storageHref("app-storage"), "/control/libraries/storage#app-storage", "storage"]
  ])("%s", (href, expected, section) => {
    expect(href).toBe(expected);
    at(href);
    expect(getRoute()).toEqual({ name: "control", section });
  });

  it("reads a parameter as it was on arrival, or an empty string", () => {
    at("/control/maintenance/tasks?library=lib1");
    expect(initialParam("library")).toBe("lib1");
    expect(initialParam("status")).toBe("");
  });
});
