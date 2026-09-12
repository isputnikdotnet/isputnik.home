import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});

const { api } = await import("../src/api");
const { useBookLike } = await import("../src/features/audiobooks/catalog/useBookLike");
import type { AudiobookBook } from "../src/features/audiobooks/types";

function book(over: Partial<AudiobookBook> = {}): AudiobookBook {
  return {
    id: "b1", libraryId: "lib", folderPath: "/x", status: "ready", title: "Treasure Island",
    series: null, seriesPosition: null, authors: [], narrators: [], category: null, tags: [],
    language: null, fileCount: 1, totalSize: 1, editionCount: 1, durationSeconds: 60,
    coverUrl: null, coverLargeUrl: null, publisher: null, asin: null, saved: false,
    discoveredAt: "2020-01-01", updatedAt: "2020-01-01",
    ...over
  };
}

// Both toggles a catalog tile carries are optimistic AND have to follow the book
// the catalog hands down — the tile is re-rendered with a fresh object on every
// refresh. They are derived from it, so a refresh is adopted in the same render;
// they used to be copies kept in step by effects, which showed the previous
// values for a render and could undo a flip the server had accepted.
function Tile({ subject }: { subject: AudiobookBook }) {
  const { liked, status, toggleLike, toggleFinished } = useBookLike(subject);
  return (
    <>
      <span data-testid="liked">{liked ? "liked" : "not liked"}</span>
      <span data-testid="status">{status}</span>
      <button type="button" onClick={() => void toggleLike()}>like</button>
      <button type="button" onClick={() => void toggleFinished()}>finish</button>
    </>
  );
}

function Harness({ initial }: { initial: AudiobookBook }) {
  const [subject, setSubject] = useState(initial);
  const [tick, setTick] = useState(0);
  return (
    <>
      <Tile subject={subject} />
      <button type="button" onClick={() => setSubject(book({ saved: true }))}>catalog says saved</button>
      <button type="button" onClick={() => setSubject(book({ progress: { percentComplete: 100, completedAt: "2025-01-01" } }))}>catalog says finished</button>
      {/* A refresh that changes nothing the toggles read — a new object all the same. */}
      <button type="button" onClick={() => setSubject(book({ updatedAt: String(tick) }))}>refresh</button>
      <button type="button" onClick={() => setTick(tick + 1)}>re-render {tick}</button>
    </>
  );
}

const liked = () => screen.getByTestId("liked").textContent;
const status = () => screen.getByTestId("status").textContent;

beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue({} as never);
});

describe("useBookLike", () => {
  it("reads the like straight off the book", () => {
    render(<Harness initial={book({ saved: true })} />);
    expect(liked()).toBe("liked");
  });

  it("follows the book when the catalog refreshes it", () => {
    render(<Harness initial={book()} />);
    expect(liked()).toBe("not liked");
    fireEvent.click(screen.getByRole("button", { name: "catalog says saved" }));
    expect(liked()).toBe("liked");
  });

  it("follows the book's progress when the catalog refreshes it", () => {
    render(<Harness initial={book()} />);
    expect(status()).toBe("none");
    fireEvent.click(screen.getByRole("button", { name: "catalog says finished" }));
    expect(status()).toBe("finished");
  });

  it("flips at once, and keeps the flip across a refresh that has not caught up", async () => {
    render(<Harness initial={book()} />);
    await userEvent.click(screen.getByRole("button", { name: "like" }));
    expect(liked()).toBe("liked");
    fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    expect(liked()).toBe("liked");
    // …and once the catalog carries it, the book is the only source again.
    fireEvent.click(screen.getByRole("button", { name: "catalog says saved" }));
    expect(liked()).toBe("liked");
  });

  it("puts the flip back when the server refuses", async () => {
    vi.mocked(api).mockRejectedValue(new Error("nope"));
    render(<Harness initial={book()} />);
    await userEvent.click(screen.getByRole("button", { name: "like" }));
    await waitFor(() => expect(liked()).toBe("not liked"));
  });

  it("does not reset on an unrelated re-render", async () => {
    render(<Harness initial={book()} />);
    await userEvent.click(screen.getByRole("button", { name: "finish" }));
    expect(status()).toBe("finished");
    fireEvent.click(screen.getByRole("button", { name: /re-render/ }));
    expect(status()).toBe("finished");
  });
});
