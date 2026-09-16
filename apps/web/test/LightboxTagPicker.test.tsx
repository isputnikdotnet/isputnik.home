import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});

const { api } = await import("../src/api");
const { LightboxTagPicker } = await import("../src/features/gallery/LightboxTagPicker");
const mockApi = vi.mocked(api);

// The lightbox's tag picker: the gallery's own tags (not every book's), most-used
// first, without what is on the photo, and a typed tag handed back as a name.

const TAGS = [
  { name: "Summer", galleryCount: 3 },
  { name: "Dacha", galleryCount: 14 },
  { name: "Science fiction", galleryCount: 0 },
  { name: "Family", galleryCount: 30 }
];

async function setup(tags: string[] = ["family"]) {
  mockApi.mockResolvedValue({ tags: TAGS } as never);
  const onPick = vi.fn(async () => true);
  const onClose = vi.fn();
  render(<LightboxTagPicker tags={tags} busy={false} onPick={onPick} onClose={onClose} />);
  const names = () => {
    const list = screen.queryByRole("listbox");
    if (!list) return [];
    return within(list).getAllByRole("option").map((row) =>
      [...row.querySelectorAll(".lb-suggest-name, .lb-suggest-detail")].map((part) => part.textContent).join(" · "));
  };
  await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());
  return { onPick, onClose, names };
}

describe("LightboxTagPicker", () => {
  it("offers the gallery's tags, most-used first, leaving out the photo's own in any case", async () => {
    const { names } = await setup();
    expect(mockApi).toHaveBeenCalledWith("/api/library/tags");
    expect(names()).toEqual(["Dacha · used 14 times", "Summer · used 3 times"]);
  });

  it("picks a tag with Enter and hands back its name", async () => {
    const { onPick } = await setup();
    await userEvent.type(screen.getByRole("combobox"), "sum{Enter}");
    expect(onPick).toHaveBeenCalledWith("Summer");
    expect(screen.getByRole("combobox")).toHaveValue("");
  });

  it("offers a new tag only when no tag of that name exists", async () => {
    const { onPick, names } = await setup();
    const box = screen.getByRole("combobox");
    await userEvent.type(box, "FAMILY");
    expect(names()).toEqual([]);
    await userEvent.clear(box);
    await userEvent.type(box, "Grandma's house");
    expect(names()).toEqual(["Add “Grandma's house” as a new tag"]);
    await userEvent.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith("Grandma's house");
  });
});
