import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TagEditor } from "../src/shared/tags/TagEditor";

// The one editor for the tags on one thing: most-used suggestions first, without
// what the thing already wears in any case, and a typed tag handed back as a name.

const SUGGESTIONS = [
  { name: "Summer", uses: 3 },
  { name: "Dacha", uses: 14 },
  { name: "Family", uses: 30 }
];

const rows = () => {
  const list = screen.queryByRole("listbox");
  if (!list) return [];
  return within(list).getAllByRole("option").map((row) =>
    [...row.querySelectorAll(".suggest-box-name, .suggest-box-detail")].map((part) => part.textContent).join(" · "));
};

describe("TagEditor", () => {
  it("opens the search from the + and offers the most-used tags the thing lacks", async () => {
    render(<TagEditor tags={["family"]} suggestions={SUGGESTIONS} onAdd={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Add a tag" }));
    expect(rows()).toEqual(["Dacha · used 14 times", "Summer · used 3 times"]);
  });

  it("picks with Enter, clears the box and stays open for the next one", async () => {
    const onAdd = vi.fn();
    render(<TagEditor tags={[]} suggestions={SUGGESTIONS} onAdd={onAdd} alwaysOpen />);
    await userEvent.type(screen.getByRole("combobox"), "sum{Enter}");
    expect(onAdd).toHaveBeenCalledWith("Summer");
    expect(screen.getByRole("combobox")).toHaveValue("");
  });

  it("offers a new tag only when no tag of that name exists", async () => {
    const onAdd = vi.fn();
    render(<TagEditor tags={["family"]} suggestions={SUGGESTIONS} onAdd={onAdd} alwaysOpen />);
    const box = screen.getByRole("combobox");
    await userEvent.type(box, "FAMILY");
    expect(rows()).toEqual([]);
    await userEvent.clear(box);
    await userEvent.type(box, "Grandma's house{Enter}");
    expect(onAdd).toHaveBeenCalledWith("Grandma's house");
  });

  it("keeps what was typed when the tag did not go on", async () => {
    render(<TagEditor tags={[]} suggestions={[]} onAdd={async () => false} alwaysOpen />);
    await userEvent.type(screen.getByRole("combobox"), "Lake{Enter}");
    expect(screen.getByRole("combobox")).toHaveValue("Lake");
  });

  it("removes with the chip's ×", async () => {
    const onRemove = vi.fn();
    render(<TagEditor tags={["Lake"]} suggestions={[]} onAdd={vi.fn()} onRemove={onRemove} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove “Lake”" }));
    expect(onRemove).toHaveBeenCalledWith("Lake");
  });

  it("is only chips without handlers, and nothing at all with no tags", () => {
    const { rerender, container } = render(<TagEditor tags={["Lake"]} suggestions={[]} />);
    expect(screen.getByText("Lake")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<TagEditor tags={[]} suggestions={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
