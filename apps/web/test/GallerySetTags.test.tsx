import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});

const { api } = await import("../src/api");
const { GallerySetTags } = await import("../src/features/gallery/GallerySetTags");
const mockApi = vi.mocked(api);

// Tags on an album or slideshow: the shared TagEditor, saving each change straight
// away. The album and slideshow lists reload themselves (a rename, a cover change,
// a poll), handing this component a new `tags` array while someone is typing — the
// typed word must survive that.
function Harness({ initial }: { initial: string[] }) {
  const [tags, setTags] = useState(initial);
  return (
    <>
      <GallerySetTags endpoint="/api/albums/a1/tags" tags={tags} canEdit onSaved={setTags} />
      <button type="button" onClick={() => setTags(["Reloaded"])}>reload</button>
    </>
  );
}

beforeEach(() => {
  mockApi.mockReset();
  mockApi.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/library/tags") return { tags: [] } as never;
    return { tags: JSON.parse(String(init?.body)).tags } as never;
  });
});

describe("GallerySetTags", () => {
  it("links each tag to its browse page", () => {
    render(<Harness initial={["Minnesota"]} />);
    expect(screen.getByRole("link", { name: "Minnesota" })).toHaveAttribute("href", "/tags/Minnesota");
  });

  it("saves a picked tag on top of the set's own", async () => {
    render(<Harness initial={["Minnesota"]} />);
    await userEvent.click(screen.getByRole("button", { name: "Add a tag" }));
    await userEvent.type(screen.getByRole("combobox"), "Lake{Enter}");
    expect(mockApi).toHaveBeenCalledWith("/api/albums/a1/tags", { method: "PUT", body: JSON.stringify({ tags: ["Minnesota", "Lake"] }) });
    await waitFor(() => expect(screen.getByRole("link", { name: "Lake" })).toBeInTheDocument());
  });

  it("saves the set without a removed tag", async () => {
    render(<Harness initial={["Minnesota", "Lake"]} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove “Lake”" }));
    expect(mockApi).toHaveBeenCalledWith("/api/albums/a1/tags", { method: "PUT", body: JSON.stringify({ tags: ["Minnesota"] }) });
  });

  it("keeps a half-typed tag when the list reloads underneath", async () => {
    render(<Harness initial={["Minnesota"]} />);
    await userEvent.click(screen.getByRole("button", { name: "Add a tag" }));
    await userEvent.type(screen.getByRole("combobox"), "Lak");
    fireEvent.click(screen.getByRole("button", { name: "reload" }));
    expect(screen.getByRole("combobox")).toHaveValue("Lak");
    expect(screen.getByRole("link", { name: "Reloaded" })).toBeInTheDocument();
  });
});
