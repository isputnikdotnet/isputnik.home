import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StoryShareView, type StorySharePayload } from "../src/pages/StoryShareView";

// The guest page has no media pipeline in jsdom; what matters here is which
// player a narration block renders with.
beforeEach(() => {
  Object.defineProperty(HTMLMediaElement.prototype, "load", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: vi.fn().mockResolvedValue(undefined) });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => null });
});

const payload = (): StorySharePayload => ({
  type: "story",
  share: { label: null, expiresAt: "2030-01-01T00:00:00Z", sharedBy: "Sergey" },
  story: {
    title: "Alps in summer",
    subtitle: null,
    chapterNoun: null,
    intro: null,
    rating: null,
    servings: null,
    cookMinutes: null,
    authorName: null,
    cover: null,
    expandAlbums: false,
    chapters: [{
      id: "c1",
      title: null,
      date: null,
      endDate: null,
      dateApprox: false,
      place: null,
      placeLat: null,
      placeLng: null,
      standfirst: null,
      description: null,
      hero: null,
      blocks: [
        { kind: "text", body: "By the third day the road was closed, so we walked." },
        { kind: "audio", title: "Dad, about the walk", durationSeconds: 78, url: "/api/share/tok/audio/a1", caption: "At the kitchen table." }
      ]
    }]
  }
});

// A guest hears narration through the same card the family does: the shared
// player with its play button and seek control, not the browser's own control.
describe("StoryShareView narration", () => {
  it("renders a narration block with the shared player, fetching nothing until pressed", () => {
    render(<StoryShareView token="tok" payload={payload()} />);
    expect(screen.getByText("Dad, about the walk")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Seek" })).toBeInTheDocument();
    const audio = document.querySelector("audio");
    expect(audio?.getAttribute("src")).toBe("/api/share/tok/audio/a1");
    expect(audio?.getAttribute("preload")).toBe("none");
    expect(audio?.hasAttribute("controls")).toBe(false);
    expect(screen.getByText("At the kitchen table.")).toBeInTheDocument();
  });
});
