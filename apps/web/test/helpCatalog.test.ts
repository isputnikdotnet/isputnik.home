// The Help page arranges the guides by topic for two audiences. Every guide must be
// reachable exactly once from /help/guides for the people allowed to open it, and
// members must never be handed a setup guide for a panel they can't open.
import { describe, expect, it } from "vitest";
import { GUIDES, helpTopics, quickStart, topicHref, type GuideKey } from "../src/features/help/catalog";

const allKeys = Object.keys(GUIDES) as GuideKey[];
const adminOnly = (key: GuideKey) => Boolean((GUIDES[key] as { adminOnly?: boolean }).adminOnly);

describe("help catalog", () => {
  it.each([
    ["admin", true],
    ["member", false]
  ])("lists every guide a %s can open exactly once", (_label, isAdmin) => {
    const listed = helpTopics(isAdmin).flatMap((topic) => topic.guides);
    const expected = allKeys.filter((key) => isAdmin || !adminOnly(key));
    expect([...listed].sort()).toEqual([...expected].sort());
  });

  it("gives both audiences eight topics, so the two columns come out even", () => {
    expect(helpTopics(true)).toHaveLength(8);
    expect(helpTopics(false)).toHaveLength(8);
  });

  it("never shows a member a quick-start tile for an admin guide", () => {
    for (const tile of quickStart(false)) expect(adminOnly(tile.guide)).toBe(false);
  });

  it("opens a one-guide topic straight at the guide and a larger one at its section", () => {
    const topics = helpTopics(true);
    expect(topicHref(topics.find((topic) => topic.id === "audiobooks")!)).toBe("/help/library-audiobooks");
    expect(topicHref(topics.find((topic) => topic.id === "gallery")!)).toBe("/help/guides#gallery");
  });
});
