import { describe, expect, it } from "vitest";
import { CONTROL_PATHS, type ControlSection } from "../src/router";
import { ALL_TABS, APPLICATIONS, CONTROL_GROUPS, parentTab, placeOf, selectedTab } from "../src/features/control/nav";

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
