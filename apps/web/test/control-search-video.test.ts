// Control panel search finds the video cache settings (docs/video-cache-plan.md):
// where converted video is kept, films kept after watching, titles kept ready,
// and when downloads are prepared — each on the Videos settings page, scrolled to
// the group it sits in.
import { describe, expect, it } from "vitest";
import { searchControlPanel } from "../src/features/control/search-index";

const titlesFor = (query: string) => searchControlPanel(query).map((entry) => entry.title);

describe("searching the video cache settings", () => {
  it("finds each by the words people use", () => {
    expect(titlesFor("transcode disk")).toContain("Where converted video is kept");
    expect(titlesFor("keep ready")).toContain("Titles kept ready");
    expect(titlesFor("kept after watching")).toContain("Films kept after watching");
    expect(titlesFor("night")).toContain("When downloads are prepared");
    expect(titlesFor("download speed")).toContain("When downloads are prepared");
  });

  it("lands on the Videos settings page, at the group the setting is in", () => {
    const hit = searchControlPanel("keep ready").find((entry) => entry.title === "Titles kept ready")!;
    // Downloads and what is kept are on the Video Downloads tab; the disk on Video Streaming.
    expect(hit.href).toMatch(/\/control\/apps\/videos\/downloads#video-copies$/);
    expect(searchControlPanel("transcode disk").find((entry) => entry.title === "Where converted video is kept")!.href).toMatch(/\/control\/apps\/videos\/streaming#/);
    const storage = searchControlPanel("transcode disk").find((entry) => entry.title === "Where converted video is kept")!;
    // Its own card on the one page: Disk and memory.
    expect(storage.href).toMatch(/#video-conversion-storage$/);
  });
});
