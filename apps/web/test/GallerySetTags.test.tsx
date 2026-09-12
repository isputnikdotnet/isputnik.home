import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});

const { api } = await import("../src/api");
const { GallerySetTags } = await import("../src/features/gallery/GallerySetTags");

// The album and slideshow lists reload themselves (a rename, a cover change, a
// poll), handing this component a new `tags` array while the combobox is open. The
// draft is seeded when the editor OPENS, not from an effect following the prop —
// which used to wipe a tag half-typed.
function Harness({ initial }: { initial: string[] }) {
  const [tags, setTags] = useState(initial);
  const [tick, setTick] = useState(0);
  return (
    <>
      <GallerySetTags endpoint="/api/albums/a1/tags" tags={tags} canEdit onSaved={setTags} />
      <button type="button" onClick={() => setTags(["Reloaded"])}>reload</button>
      <button type="button" onClick={() => setTick(tick + 1)}>re-render {tick}</button>
    </>
  );
}

beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue({ tags: [] } as never);
});

describe("GallerySetTags draft", () => {
  it("opens seeded from the set's current tags", async () => {
    render(<Harness initial={["Minnesota"]} />);
    await userEvent.click(screen.getByRole("button", { name: /Edit tags|Add tags/ }));
    expect(screen.getByText("Minnesota")).toBeInTheDocument();
  });

  it("keeps the chips being edited when the list reloads underneath", async () => {
    render(<Harness initial={["Minnesota"]} />);
    await userEvent.click(screen.getByRole("button", { name: /Edit tags|Add tags/ }));
    fireEvent.click(screen.getByRole("button", { name: "reload" }));
    // Still editing the set as it was opened — not the reloaded "Reloaded" tag.
    expect(screen.getByText("Minnesota")).toBeInTheDocument();
    expect(screen.queryByText("Reloaded")).toBeNull();
  });

  it("does not reset the draft on an unrelated re-render", async () => {
    render(<Harness initial={["Minnesota"]} />);
    await userEvent.click(screen.getByRole("button", { name: /Edit tags|Add tags/ }));
    fireEvent.click(screen.getByRole("button", { name: /re-render/ }));
    expect(screen.getByText("Minnesota")).toBeInTheDocument();
  });

  it("seeds the next edit from whatever the set says now", async () => {
    render(<Harness initial={["Minnesota"]} />);
    fireEvent.click(screen.getByRole("button", { name: "reload" }));
    await userEvent.click(screen.getByRole("button", { name: /Edit tags|Add tags/ }));
    expect(screen.getByText("Reloaded")).toBeInTheDocument();
  });
});
