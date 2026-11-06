// The Help page puts the guides on shelves for two audiences. Every guide must sit
// on exactly one shelf for the people allowed to open it, and members must never
// be handed a setup guide for a panel they can't open.
import { describe, expect, it } from "vitest";
import { FEATURED_GUIDE, GUIDES, guideVisible, helpShelves, shelfOf, type GuideKey } from "../src/features/help/catalog";

const allKeys = Object.keys(GUIDES) as GuideKey[];
const adminOnly = (key: GuideKey) => Boolean((GUIDES[key] as { adminOnly?: boolean }).adminOnly);

describe("help catalog", () => {
  it.each([
    ["admin", true],
    ["member", false]
  ])("puts every guide a %s can open on exactly one shelf", (_label, isAdmin) => {
    const listed = helpShelves(isAdmin).flatMap((shelf) => shelf.guides);
    const expected = allKeys.filter((key) => isAdmin || !adminOnly(key));
    expect([...listed].sort()).toEqual([...expected].sort());
  });

  it("gives members no administrators' shelf and no empty shelf", () => {
    const shelves = helpShelves(false);
    expect(shelves.some((shelf) => shelf.adminOnly)).toBe(false);
    for (const shelf of shelves) expect(shelf.guides.length).toBeGreaterThan(0);
  });

  it("features a guide everyone can open", () => {
    expect(guideVisible(FEATURED_GUIDE.guide, false)).toBe(true);
  });

  it("finds a guide's shelf by its slug", () => {
    expect(shelfOf("phone-backup")?.id).toBe("photos");
    expect(shelfOf("phone-sync-setup")?.id).toBe("server");
    expect(shelfOf("no-such-guide")).toBeUndefined();
  });
});
