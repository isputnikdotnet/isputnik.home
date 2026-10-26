import { describe, expect, it } from "vitest";
import { CONTROL_PATHS, type ControlSection } from "../src/router";
import { ALL_TABS, CONTROL_GROUPS } from "../src/features/control/nav";

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

  // Six until Apps joined (docs/apps-platform-plan.md); raising it again is a
  // decision for nav.ts's comment, not a number to bump here.
  it("keeps to the seven-group budget", () => {
    expect(CONTROL_GROUPS.length).toBeLessThanOrEqual(7);
  });
});
