import { beforeEach, describe, expect, it } from "vitest";
import { getRoute, groupHref, memberHref } from "../src/router";
import { blockIpHref, groupAccessHref, initialParam, libraryRowHref, logsHref, recycleBinHref, storageHref, tasksHref, userAccessHref } from "../src/features/control/links";

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

  // A member's page is a sub-page of Users, so it must not be shadowed by the
  // Members tabs that share its prefix — and the dialog's old tab names still
  // land on the page's tabs.
  it.each([
    [userAccessHref("acct_123"), "/control/members/acct_123", "account"],
    [userAccessHref("acct_123", "groups"), "/control/members/acct_123", "account"],
    [userAccessHref("acct_123", "photos"), "/control/members/acct_123/photos", "photos"],
    [memberHref("acct_123", "stories"), "/control/members/acct_123/stories", "stories"],
    [memberHref("acct_123", "shared"), "/control/members/acct_123/shared", "shared"]
  ])("%s", (href, expected, tab) => {
    expect(href).toBe(expected);
    at(href);
    expect(getRoute()).toEqual({ name: "controlMember", userId: "acct_123", tab });
  });

  // A group's page sits under the Groups tab's address and must not read as a
  // member called "groups"; the dialog's old tab names are accepted and ignored.
  it.each([
    [groupAccessHref("grp_1"), "/control/members/groups/grp_1"],
    [groupAccessHref("grp_1", "photos"), "/control/members/groups/grp_1"],
    [groupHref("grp_1"), "/control/members/groups/grp_1"]
  ])("%s", (href, expected) => {
    expect(href).toBe(expected);
    at(href);
    expect(getRoute()).toEqual({ name: "controlGroup", groupId: "grp_1" });
  });

  it("keeps the Members tabs ahead of the member page", () => {
    at("/control/members/groups");
    expect(getRoute()).toEqual({ name: "control", section: "groups" });
    at("/control/members/invites");
    expect(getRoute()).toEqual({ name: "control", section: "invites" });
  });

  it("reads a parameter as it was on arrival, or an empty string", () => {
    at("/control/maintenance/tasks?library=lib1");
    expect(initialParam("library")).toBe("lib1");
    expect(initialParam("status")).toBe("");
  });
});
