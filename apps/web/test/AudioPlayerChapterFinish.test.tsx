import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudiobookBookDetail } from "../src/features/audiobooks/types";
import { api } from "../src/api";
import { persistProgress } from "../src/offline/progress";

vi.mock("../src/api", () => ({
  api: vi.fn(async (path: string) => (path.endsWith("/bookmarks") ? { bookmarks: [] } : { progress: null }))
}));
vi.mock("../src/offline/downloads", () => ({ getDownloadedFileUrl: vi.fn(async () => null) }));
vi.mock("../src/offline/progress", () => ({
  getLocalProgress: vi.fn(async () => null),
  persistProgress: vi.fn(async () => undefined)
}));

const { AudioPlayer } = await import("../src/features/audiobooks/AudioPlayer");

// The player's chapter list carries the book page's per-chapter "Mark finished".
// The player is the book's one cursor, so the ring moves it: finishing a track
// parks playback at the start of the next one (the end of the last file for the
// last track, which the server reads as finishing the book), un-finishing parks it
// at the track's own start, and a finished book is reset first because a cursor
// write never clears completed_at. jsdom has no media pipeline, so the element's
// methods are stubbed and the saved position is what the test can see.

const file = (id: string, title: string) => ({
  id, relativePath: `${id}.mp3`, mimeType: "audio/mpeg", trackNumber: null, chapterTitle: title,
  durationSeconds: 600, size: 1, modifiedAt: null, status: "available" as const
});

const book = {
  id: "b1", title: "Treasure Island", progressMode: "linear",
  files: [file("f1", "The Old Sea-dog"), file("f2", "Black Dog")]
} as unknown as AudiobookBookDetail;

const lastSave = () => vi.mocked(persistProgress).mock.calls.at(-1)?.slice(0, 3);

async function openList(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Chapter list" }));
  return document.getElementById(screen.getByRole("button", { name: "Chapter list" }).getAttribute("aria-controls")!)!;
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.mocked(persistProgress).mockClear();
  vi.mocked(api).mockClear();
});
afterEach(() => { vi.restoreAllMocks(); });

describe("AudioPlayer chapter finish toggle", () => {
  it("finishing a track moves the cursor to the next one, and un-finishing moves it back", async () => {
    const user = userEvent.setup();
    render(<AudioPlayer book={book} />);
    const list = await openList(user);
    const rings = within(list).getAllByRole("button", { name: "Mark track finished" });
    expect(rings).toHaveLength(2);
    expect(rings[0]).toHaveAttribute("aria-pressed", "false");

    await user.click(rings[0]);
    await waitFor(() => expect(within(list).getByRole("button", { name: /Black Dog/ })).toHaveAttribute("aria-current", "true"));
    expect(lastSave()).toEqual(["b1", "f2", 0]);
    // The list stays open, and the finished track now offers the way back.
    const undo = within(list).getByRole("button", { name: "Mark track unfinished" });
    expect(undo).toHaveAttribute("aria-pressed", "true");

    await user.click(undo);
    await waitFor(() => expect(within(list).getByRole("button", { name: /The Old Sea-dog/ })).toHaveAttribute("aria-current", "true"));
    expect(lastSave()).toEqual(["b1", "f1", 0]);
    expect(vi.mocked(api).mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("resets a finished book before un-finishing a track", async () => {
    const user = userEvent.setup();
    render(<AudioPlayer book={book} />);
    const list = await openList(user);
    await user.click(within(list).getAllByRole("button", { name: "Mark track finished" })[0]);
    await waitFor(() => expect(within(list).getByRole("button", { name: "Mark track unfinished" })).toBeInTheDocument());

    vi.mocked(api).mockImplementationOnce(async () => ({
      progress: { fileId: "f2", positionSeconds: 600, percentComplete: 1, completedAt: "2026-10-20T00:00:00Z" }
    }));
    await user.click(within(list).getByRole("button", { name: "Mark track unfinished" }));
    await waitFor(() => expect(lastSave()).toEqual(["b1", "f1", 0]));
    const calls = vi.mocked(api).mock.calls.map(([path, init]) => `${init?.method ?? "GET"} ${path}`);
    expect(calls).toContain("DELETE /api/library/books/b1/progress");
    expect(calls.indexOf("DELETE /api/library/books/b1/progress")).toBeGreaterThan(calls.lastIndexOf("GET /api/library/books/b1/progress") - 1);
  });

  it("finishing the last track parks the cursor at its end", async () => {
    const user = userEvent.setup();
    render(<AudioPlayer book={book} />);
    const list = await openList(user);
    await user.click(within(list).getAllByRole("button", { name: "Mark track finished" })[1]);
    await waitFor(() => expect(lastSave()).toEqual(["b1", "f2", 600]));
  });

  it("keeps the rings display-only for an episodic library", async () => {
    const user = userEvent.setup();
    render(<AudioPlayer book={{ ...book, progressMode: "episodic" } as AudiobookBookDetail} />);
    const list = await openList(user);
    expect(within(list).queryByRole("button", { name: /Mark track/ })).toBeNull();
    expect(within(list).getByRole("button", { name: /The Old Sea-dog/ })).toHaveAttribute("aria-current", "true");
  });
});
