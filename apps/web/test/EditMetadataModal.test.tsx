import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});

const { api } = await import("../src/api");
const { EditMetadataModal } = await import("../src/features/audiobooks/EditMetadataModal");
import type { AudiobookBookDetail } from "../src/features/audiobooks/types";

function detail(over: Partial<AudiobookBookDetail> = {}): AudiobookBookDetail {
  return {
    id: "b1", libraryId: "lib", folderPath: "/x", status: "ready", title: "Treasure Island",
    series: null, seriesPosition: null, authors: ["Stevenson"], narrators: [], category: null,
    tags: [], language: null, fileCount: 1, totalSize: 1, editionCount: 1, durationSeconds: 60,
    coverUrl: null, coverLargeUrl: null, publisher: null, asin: null, saved: false,
    discoveredAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z",
    libraryName: "Books", progressMode: "position", seriesId: null, description: null,
    yearPublished: null, isbn: null, openLibraryId: null, metadataSource: "scan",
    workId: null, files: [], documents: [],
    ...over
  } as AudiobookBookDetail;
}

// Both hosts (BookDetailPage, the catalog grid) hand this dialog a NEW book object
// on every refresh — a scan poll, a cover applied, the detail re-read. The Edit
// tab's form is therefore seeded once, keyed on the book's id, instead of following
// the prop from an effect: that effect wiped a half-typed title.
function Harness({ first, second }: { first: AudiobookBookDetail; second: AudiobookBookDetail }) {
  const [book, setBook] = useState(first);
  const [tick, setTick] = useState(0);
  return (
    <>
      <EditMetadataModal key={book.id} book={book} onBookUpdated={setBook} onClose={() => {}} />
      {/* A refresh of the SAME book — a new object, same id. */}
      <button type="button" onClick={() => setBook({ ...book, updatedAt: "later" })}>refresh</button>
      {/* The dialog opened for a DIFFERENT book. */}
      <button type="button" onClick={() => setBook(second)}>other book</button>
      <button type="button" onClick={() => setTick(tick + 1)}>re-render {tick}</button>
    </>
  );
}

const titleField = () => screen.getByLabelText("Title") as HTMLInputElement;

beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue({ people: [], series: [], categories: [], tags: [] } as never);
});

describe("EditMetadataModal edit form", () => {
  it("opens seeded from the book", () => {
    render(<Harness first={detail()} second={detail({ id: "b2", title: "Kidnapped" })} />);
    expect(titleField()).toHaveValue("Treasure Island");
  });

  it("keeps a half-typed title when the host refreshes the same book", async () => {
    render(<Harness first={detail()} second={detail({ id: "b2", title: "Kidnapped" })} />);
    await userEvent.clear(titleField());
    await userEvent.type(titleField(), "Treasure Island (1883)");
    fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    expect(titleField()).toHaveValue("Treasure Island (1883)");
  });

  it("does not reset the form on an unrelated re-render", async () => {
    render(<Harness first={detail()} second={detail({ id: "b2", title: "Kidnapped" })} />);
    await userEvent.type(titleField(), " (1883)");
    fireEvent.click(screen.getByRole("button", { name: /re-render/ }));
    expect(titleField()).toHaveValue("Treasure Island (1883)");
  });

  it("re-seeds for a different book, because the host keys it on the id", async () => {
    render(<Harness first={detail()} second={detail({ id: "b2", title: "Kidnapped" })} />);
    await userEvent.type(titleField(), " (1883)");
    fireEvent.click(screen.getByRole("button", { name: "other book" }));
    expect(titleField()).toHaveValue("Kidnapped");
  });
});
