import { describe, expect, it } from "vitest";
import { CONTROL_PATHS, type ControlSection } from "../src/router";
import { ALL_TABS, CONTROL_GROUPS, parentTab, selectedTab } from "../src/features/control/nav";

// nav.ts is the control panel's whole shape. A section with an address but no tab
// is a page nothing links to; a section on two tabs has two eyebrows.
describe("control panel nav", () => {
  it("puts every addressable section on exactly one tab", () => {
    const sections = Object.keys(CONTROL_PATHS) as ControlSection[];
    const counts = new Map<ControlSection, number>();
    for (const tab of ALL_TABS) counts.set(tab.section, (counts.get(tab.section) ?? 0) + 1);
    for (const section of sections) {
      expect(counts.get(section), section).toBe(1);
    }
    expect(ALL_TABS).toHaveLength(sections.length);
  });

  // A page under a tab (4.73) keeps that tab selected and names it in its eyebrow;
  // a tab is its own selection and has no parent.
  it("keeps Organization selected on its editor pages", () => {
    for (const page of ["categories", "tags", "genres"] as const) {
      expect(parentTab(page)).toBe("organization");
      expect(selectedTab(page)).toBe("organization");
    }
    expect(parentTab("organization")).toBeNull();
    expect(selectedTab("storage")).toBe("storage");
  });

  it("gives Library one row of five tabs, each answering one question", () => {
    const library = CONTROL_GROUPS.find((group) => group.key === "library");
    expect(library?.tabs.map((tab) => tab.section)).toEqual(["libraries", "organization", "phoneSync", "storage", "storageContents"]);
  });

  // Six until Apps joined (docs/apps-platform-plan.md); raising it again is a
  // decision for nav.ts's comment, not a number to bump here.
  it("keeps to the seven-group budget", () => {
    expect(CONTROL_GROUPS.length).toBeLessThanOrEqual(7);
  });
});
