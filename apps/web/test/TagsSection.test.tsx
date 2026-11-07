import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn() }));
const { api } = await import("../src/api");
const { TagsSection } = await import("../src/features/control/sections/TagsSection");
const mockApi = vi.mocked(api);

// The server sends two usage counts per tag: library items (books and Gallery
// photos) and everything else (albums, slideshows, stories, family-tree people).
// The page once read only the first, so a tag on a story or a person counted
// toward "Remove unused" and its delete dialog said it was on 0 books. Unused
// means both are zero — the same rule the server's prune applies.

const TAGS = [
  { id: "t-book", name: "Fiction", libraryItemCount: 3, otherCount: 0 },
  { id: "t-story", name: "Grandpa", libraryItemCount: 0, otherCount: 2 },
  { id: "t-both", name: "Summer", libraryItemCount: 1, otherCount: 1 },
  { id: "t-none", name: "Leftover", libraryItemCount: 0, otherCount: 0 }
];

beforeEach(() => {
  mockApi.mockReset();
  mockApi.mockImplementation(async () => ({ tags: TAGS }));
});

const rowOf = (name: string) => screen.getByText(name).closest("tr")!;

describe("tags tab", () => {
  it("shows both counts on every row", async () => {
    render(<TagsSection />);
    await screen.findByText("Grandpa");
    expect(screen.getByRole("columnheader", { name: "Library items" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Elsewhere" })).toBeInTheDocument();
    const cells = within(rowOf("Grandpa")).getAllByRole("cell").map((cell) => cell.textContent);
    expect(cells.slice(1, 3)).toEqual(["0", "2"]);
  });

  it("counts only tags used nowhere as unused", async () => {
    render(<TagsSection />);
    await screen.findByText("Grandpa");
    expect(screen.getByRole("button", { name: "Remove unused (1)" })).toBeEnabled();
  });

  it("states every use of a tag before deleting it", async () => {
    render(<TagsSection />);
    await screen.findByText("Summer");
    await userEvent.click(within(rowOf("Summer")).getByTitle("Delete tag"));
    expect(screen.getByText(/removes the tag from 2 items/)).toBeInTheDocument();
  });

  it("says when a tag about to be deleted is not used anywhere", async () => {
    render(<TagsSection />);
    await screen.findByText("Leftover");
    await userEvent.click(within(rowOf("Leftover")).getByTitle("Delete tag"));
    expect(screen.getByText(/isn't used anywhere/)).toBeInTheDocument();
  });
});
