import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The choice is read once, when the module loads, so each case loads it afresh.
const load = async () => {
  vi.resetModules();
  return import("../src/app/layoutChoice");
};

describe("layoutChoice", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is the top bar unless this browser asked otherwise", async () => {
    const { layoutChoice, usesTopLayout } = await load();
    expect(layoutChoice()).toBe("top");
    expect(usesTopLayout()).toBe(true);
  });

  it("remembers the classic sidebar", async () => {
    window.localStorage.setItem("isputnik.layout", "classic");
    const { layoutChoice, usesTopLayout } = await load();
    expect(layoutChoice()).toBe("classic");
    expect(usesTopLayout()).toBe(false);
  });

  it("falls back to the top bar on anything else", async () => {
    window.localStorage.setItem("isputnik.layout", "sideways");
    const { usesTopLayout } = await load();
    expect(usesTopLayout()).toBe(true);
  });

  it("falls back to the top bar when site data is blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { usesTopLayout } = await load();
    expect(usesTopLayout()).toBe(true);
  });
});
