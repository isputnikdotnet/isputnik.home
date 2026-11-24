import { describe, expect, it } from "vitest";
import { CONTROL_PATHS, type ControlSection } from "../src/router";
import { ALL_TABS, APPLICATIONS, CONTROL_GROUPS, DASHBOARD_AREA, SECURITY_AREAS, parentTab, placeOf, sectionEyebrow, selectedTab, tabRowFor } from "../src/features/control/nav";

// nav.ts is the control panel's whole shape (docs/control-panel-v2-plan.md). A
// section with an address but no tab is a page nothing links to; a section on two
// tabs has two eyebrows.
describe("control panel nav", () => {
  it("puts every addressable section but the Dashboard on exactly one tab", () => {
    const sections = (Object.keys(CONTROL_PATHS) as ControlSection[]).filter((section) => section !== "dashboard");
    const counts = new Map<ControlSection, number>();
    for (const tab of ALL_TABS) counts.set(tab.section, (counts.get(tab.section) ?? 0) + 1);
    for (const section of sections) {
      expect(counts.get(section), section).toBe(1);
    }
    expect(ALL_TABS).toHaveLength(sections.length);
  });

  it("keeps the Dashboard out of every group: the panel's title opens it", () => {
    expect(placeOf("dashboard").group).toBeNull();
  });

  // Who got in and from where sits beside how the server is doing (owner, 2026-11-23).
  it("gives the Dashboard a row: Dashboard, Sign-ins, Sign-in locations", () => {
    expect(DASHBOARD_AREA.tabs.map((tab) => tab.section)).toEqual(["dashboard", "signIns", "signInLocations"]);
    for (const section of ["dashboard", "signIns", "signInLocations"] as const) {
      const place = placeOf(section);
      expect(place.group, section).toBeNull();
      expect(place.area?.key, section).toBe("dashboard");
      expect(tabRowFor(place).map((tab) => tab.section)).toEqual(["dashboard", "signIns", "signInLocations"]);
    }
    expect(CONTROL_PATHS.signIns).toBe("/control/sign-ins");
    expect(CONTROL_PATHS.signInLocations).toBe("/control/sign-in-locations");
    expect(sectionEyebrow("signIns")).toBe("Dashboard");
  });

  // Security & Members opens on a directory, as Applications does, and is divided
  // into two sections that each draw one row of four.
  it("divides Security & Members into User Management and Security Policies", () => {
    const security = CONTROL_GROUPS.find((group) => group.key === "security");
    expect(security?.tabs).toEqual([{ section: "securityMembers" }]);
    expect(CONTROL_PATHS.securityMembers).toBe("/control/security");
    expect(placeOf("securityMembers")).toMatchObject({ area: null, app: null, selected: "securityMembers" });
    expect(SECURITY_AREAS.map((area) => [area.key, area.tabs.map((tab) => tab.section)])).toEqual([
      ["userManagement", ["users", "groups", "invites", "appsAccess"]],
      ["securityPolicies", ["security", "securityPolicies", "securityTrusted", "securityBlocked"]]
    ]);
    for (const area of SECURITY_AREAS) {
      for (const tab of area.tabs) {
        const place = placeOf(tab.section);
        expect(place.group?.key, tab.section).toBe("security");
        expect(place.area?.key, tab.section).toBe(area.key);
        expect(tabRowFor(place)).toBe(area.tabs);
      }
    }
    expect(sectionEyebrow("groups")).toBe("Security & Members · User Management");
    expect(sectionEyebrow("securityBlocked")).toBe("Security & Members · Security Policies");
  });

  // Infrastructure opens on a card per service; a container's Pairing is a page
  // under it, so it keeps Services selected and opens with a link back.
  it("puts Pairing under Services in Infrastructure", () => {
    const infrastructure = CONTROL_GROUPS.find((group) => group.key === "infrastructure");
    expect(infrastructure?.tabs[0]).toEqual({ section: "services", pages: ["appsSetup"] });
    expect(parentTab("appsSetup")).toBe("services");
  });

  it("has five groups", () => {
    expect(CONTROL_GROUPS.map((group) => group.key)).toEqual(["infrastructure", "libraries", "applications", "security", "settings"]);
  });

  // A page under a tab keeps that tab selected and names it in its eyebrow; a tab is
  // its own selection and has no parent.
  // Gallery has no Organize tab (owner, 2026-11-19): its Overview lists the tools.
  it("keeps Overview selected on Gallery's cleanup pages", () => {
    for (const page of ["duplicateCleanup", "missingPhotos", "videoStreaming"] as const) {
      expect(parentTab(page)).toBe("gallerySetup");
      expect(selectedTab(page)).toBe("gallerySetup");
      expect(placeOf(page).app?.key).toBe("gallery");
    }
    expect(parentTab("gallerySetup")).toBeNull();
  });

  it("gives Gallery its workspace row: Overview · Device Sync · Settings", () => {
    const gallery = APPLICATIONS.find((app) => app.key === "gallery");
    expect(gallery?.tabs.map((tab) => tab.kind)).toEqual(["setup", "deviceSync", "settings"]);
  });

  // Every application opens on Setup; Shared organization is not an application.
  it("starts every application workspace on Setup", () => {
    for (const app of APPLICATIONS.filter((candidate) => candidate.key !== "shared")) {
      expect(app.tabs[0].kind, app.key).toBe("setup");
    }
  });

  // One editor, several entry points: ?from= decides which workspace it sits in.
  it("places a shared page by the workspace it was opened from", () => {
    expect(placeOf("categories", "shared")).toMatchObject({ app: null, selected: "applications", parent: "applications" });
    expect(placeOf("tags", "shared")).toMatchObject({ app: null, selected: "applications", parent: "applications" });
    expect(placeOf("categories").app?.key).toBe("ebooks");
    expect(placeOf("categories", "audiobooks")).toMatchObject({ selected: "audiobooksSetup", parent: "audiobooksSetup" });
    expect(placeOf("categories", "audiobooks").app?.key).toBe("audiobooks");

    expect(placeOf("tags").app?.key).toBe("shared");
    expect(placeOf("tags").parent).toBeNull();
    expect(placeOf("tags", "gallery")).toMatchObject({ selected: "gallerySetup", parent: "gallerySetup" });
    // A ?from= that is not an application, or one that does not use the page, is ignored.
    expect(placeOf("tags", "nonsense").app?.key).toBe("shared");
    expect(placeOf("categories", "gallery").app?.key).toBe("ebooks");
  });
});
