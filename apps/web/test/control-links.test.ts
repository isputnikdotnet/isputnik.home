import { beforeEach, describe, expect, it } from "vitest";
import { getRoute, groupHref, memberHref } from "../src/router";
import { activityHref, blockIpHref, groupAccessHref, initialParam, libraryRowHref, logsHref, recycleBinHref, storageHref, tasksHref, userAccessHref } from "../src/features/control/links";

// The links between control pages carry their narrowing in the address. Each must
// still resolve to the page it names (the router reads the path only), and leave
// out what wasn't given rather than writing "library=undefined".
const at = (url: string) => window.history.replaceState({}, "", url);

beforeEach(() => at("/"));

describe("control page links", () => {
  it.each([
    [tasksHref({ library: "lib1" }), "/control/infrastructure/tasks?library=lib1", "tasks"],
    [tasksHref({ library: undefined, type: "SCAN_GALLERY_DUPLICATES" }), "/control/infrastructure/tasks?type=SCAN_GALLERY_DUPLICATES", "tasks"],
    [tasksHref(), "/control/infrastructure/tasks", "tasks"],
    [recycleBinHref({ source: "duplicate_cleanup", library: undefined }), "/control/settings/recycle-bin?source=duplicate_cleanup", "recycleBin"],
    [logsHref({ ip: "203.0.113.9" }), "/control/infrastructure/logs?ip=203.0.113.9", "logs"],
    [logsHref({ user: "acct_123" }), "/control/infrastructure/logs?user=acct_123", "logs"],
    [blockIpHref("203.0.113.9"), "/control/security/blocked-ips?block=203.0.113.9", "securityBlocked"],
    [storageHref("app-storage"), "/control/settings/storage#app-storage", "storage"],
    // Control panel v2: an application opens Infrastructure's pages narrowed to it.
    [activityHref({ application: "gallery" }), "/control/infrastructure/activity?application=gallery", "activity"],
    [logsHref({ application: "videos" }), "/control/infrastructure/logs?application=videos", "logs"],
    [tasksHref({ application: "ebooks" }), "/control/infrastructure/tasks?application=ebooks", "tasks"]
  ])("%s", (href, expected, section) => {
    expect(href).toBe(expected);
    at(href);
    expect(getRoute()).toEqual({ name: "control", section });
  });

  // A library's Manage page (4.73) sits under the Libraries address, after the
  // Libraries tabs and the v1 addresses that share its prefix — neither may read as
  // a library id.
  it("opens a library's Manage page, behind the Library tabs", () => {
    expect(libraryRowHref("lib1")).toBe("/control/libraries/lib1");
    at(libraryRowHref("lib1"));
    expect(getRoute()).toEqual({ name: "controlLibrary", libraryId: "lib1" });
    for (const [path, section] of [
      ["/control/libraries/statistics", "libraryStats"],
      ["/control/libraries/organization", "applications"],
      ["/control/libraries/device-sync", "phoneSync"],
      ["/control/libraries/storage", "storage"],
      ["/control/libraries/storage/contents", "storageContents"]
    ] as const) {
      at(path);
      expect(getRoute()).toEqual({ name: "control", section });
    }
  });

  // The shared editors' old addresses (Library tabs, then pages under Library ›
  // Organization), and Phone sync's under Security, still land on them.
  it.each([
    ["/control/libraries/organization/categories", "categories"],
    ["/control/libraries/organization/tags", "tags"],
    ["/control/libraries/organization/genres", "genres"],
    ["/control/libraries/categories", "categories"],
    ["/control/libraries/tags", "tags"],
    ["/control/libraries/genres", "genres"],
    ["/control/security/phone-sync", "phoneSync"]
  ] as const)("%s", (path, section) => {
    at(path);
    expect(getRoute()).toEqual({ name: "control", section });
  });

  it("finds the category editor at its new address and its old ones", () => {
    at("/control/apps/ebooks/organize/categories/cat1");
    expect(getRoute()).toEqual({ name: "controlCategoryEditor", categoryId: "cat1" });
    at("/control/libraries/organization/categories/cat1");
    expect(getRoute()).toEqual({ name: "controlCategoryEditor", categoryId: "cat1" });
    at("/control/libraries/categories/new");
    expect(getRoute()).toEqual({ name: "controlCategoryEditor", categoryId: null });
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
    at("/control/infrastructure/tasks?library=lib1");
    expect(initialParam("library")).toBe("lib1");
    expect(initialParam("status")).toBe("");
  });
});
