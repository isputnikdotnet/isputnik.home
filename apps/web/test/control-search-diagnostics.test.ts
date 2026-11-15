// Control panel search finds Diagnostics by the words someone types when
// something is wrong, and its tests by name, landing on the part's page where
// each sits (docs/diagnostics-pages-plan.md).
import { describe, expect, it } from "vitest";
import { searchControlPanel } from "../src/features/control/search-index";

const hit = (query: string, title: string) => searchControlPanel(query).find((entry) => entry.title === title);

describe("searching for Diagnostics", () => {
  it("finds the page when something isn't working", () => {
    for (const query of ["not working", "bug report", "slow", "debug"]) {
      expect(hit(query, "Diagnostics"), query).toBeTruthy();
    }
  });

  it("finds each test on the page it sits on", () => {
    expect(hit("verify backup", "Verify the last backup")?.href).toBe("/control/infrastructure/diagnostics/home#backups");
    expect(hit("check folders", "Check library folders")?.href).toBe("/control/infrastructure/diagnostics/home#libraries");
    expect(hit("speed test", "Speed to this device")?.href).toBe("/control/infrastructure/diagnostics/home#speed");
    expect(hit("vaapi", "Video hardware acceleration")?.href).toBe("/control/infrastructure/diagnostics/video#hardware");
    expect(hit("log level", "Logging level (Detailed, Everything)")?.href).toBe("/control/infrastructure/diagnostics");
  });
});
