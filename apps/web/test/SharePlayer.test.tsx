import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharePage } from "../src/pages/SharePage";

// The guest audiobook player on a share link runs on the book player's own
// playback layer (features/audiobooks/usePlayback + PlayerControls) with its own,
// smaller feature set. jsdom has no media pipeline, so the element's methods are
// stubbed and the test watches what the page asks of it.

const payload = {
  type: "audiobook",
  share: { label: null, expiresAt: "2099-01-01T00:00:00Z", sharedBy: "Mama" },
  book: {
    title: "Treasure Island",
    authors: ["Robert Louis Stevenson"],
    narrators: [],
    description: null,
    durationSeconds: 120,
    coverUrl: null,
    files: [
      { id: "f1", trackNumber: 1, chapterTitle: "The Old Sea-dog", durationSeconds: 60 },
      { id: "f2", trackNumber: 2, chapterTitle: "Black Dog", durationSeconds: 3725 }
    ]
  }
};

const play = vi.fn(() => Promise.resolve());
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play);
  vi.mocked(globalThis.fetch).mockImplementation(async () => new Response(JSON.stringify(payload), { status: 200 }));
});
afterEach(() => { vi.restoreAllMocks(); play.mockClear(); });

describe("Share page audiobook player", () => {
  it("draws the transport row and plays the first chapter", async () => {
    const user = userEvent.setup();
    render(<SharePage token="tok" />);
    expect(await screen.findByText("Chapter 1 / 2")).toBeInTheDocument();
    // First chapter: nothing before it, the next one is there.
    expect(screen.getByRole("button", { name: "Previous chapter" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next chapter" })).toBeEnabled();
    expect(document.querySelector(".share-controls")?.children).toHaveLength(5);
    // The src is set in an effect, which React may run a moment after the text above
    // is on screen — wait for it rather than racing it.
    await waitFor(() => expect(document.querySelector("audio")?.getAttribute("src")).toBe("/api/share/tok/stream/f1"));

    await user.click(screen.getByRole("button", { name: "Play" }));
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("changes speed from its menu and keeps it on the next chapter", async () => {
    const user = userEvent.setup();
    render(<SharePage token="tok" />);
    await screen.findByText("Chapter 1 / 2");
    await user.click(screen.getByRole("button", { name: "Playback speed" }));
    await user.click(screen.getByRole("button", { name: "1.5×" }));
    expect(screen.getByRole("button", { name: "Playback speed" })).toHaveTextContent("1.5×");
    const audio = document.querySelector("audio")!;
    expect(audio.playbackRate).toBe(1.5);

    await user.click(screen.getByRole("button", { name: "Next chapter" }));
    expect(await screen.findByText("Chapter 2 / 2")).toBeInTheDocument();
    await waitFor(() => expect(audio.getAttribute("src")).toBe("/api/share/tok/stream/f2"));
    await waitFor(() => expect(audio.playbackRate).toBe(1.5));
  });

  it("lists the chapters with their clock lengths", async () => {
    const user = userEvent.setup();
    render(<SharePage token="tok" />);
    await screen.findByText("Chapter 1 / 2");
    await user.click(screen.getByRole("button", { name: "Chapters" }));
    expect(screen.getByText("1:00")).toBeInTheDocument();
    expect(screen.getByText("1:02:05")).toBeInTheDocument();
  });
});
