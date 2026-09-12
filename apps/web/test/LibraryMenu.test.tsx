import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LibraryMenu, type LibraryMenuOption } from "../src/shared/LibraryMenu";

// The library picker on the browse pages. A library is one value out of several,
// so the menu lists them as radio items with the current one checked — and wears
// SortMenu's keyboard (useMenuKeyboard): focus opens on the current library, the
// arrows walk the list, and Escape, Tab or a choice put focus back on the trigger.

const OPTIONS: LibraryMenuOption[] = [
  { value: "all", label: "All libraries" },
  { value: "fiction", label: "Fiction" },
  { value: "reference", label: "Reference" }
];

function libraryMenu(value = "fiction") {
  const onChange = vi.fn();
  render(
    <div>
      <LibraryMenu value={value} options={OPTIONS} label="Library" onChange={onChange} />
      <button type="button">Elsewhere</button>
    </div>
  );
  return { onChange, trigger: screen.getByRole("button", { name: "Library" }) };
}

const menu = () => screen.getByRole("menu", { name: "Library" });
const item = (name: string) => within(menu()).getByRole("menuitemradio", { name });

describe("LibraryMenu", () => {
  it("lists the libraries as radio items with the current one checked", async () => {
    const user = userEvent.setup();
    const { trigger } = libraryMenu();
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(within(menu()).getAllByRole("menuitemradio").map((option) => option.textContent))
      .toEqual(["All libraries", "Fiction", "Reference"]);
    expect(item("Fiction")).toHaveAttribute("aria-checked", "true");
    expect(item("Fiction")).toHaveClass("active");
    expect(item("Reference")).toHaveAttribute("aria-checked", "false");
    expect(within(menu()).getAllByRole("menuitemradio", { checked: true })).toHaveLength(1);
  });

  it("moves focus onto the current library when it opens", async () => {
    const user = userEvent.setup();
    const { trigger } = libraryMenu("reference");
    await user.click(trigger);
    expect(item("Reference")).toHaveFocus();
  });

  it("walks the libraries with the arrow keys, wrapping at both ends, and jumps with Home/End", async () => {
    const user = userEvent.setup();
    const { trigger } = libraryMenu("all");
    await user.click(trigger);
    expect(item("All libraries")).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(item("Fiction")).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(item("All libraries")).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(item("Reference")).toHaveFocus();
    await user.keyboard("{Home}");
    expect(item("All libraries")).toHaveFocus();
    await user.keyboard("{End}");
    expect(item("Reference")).toHaveFocus();
  });

  it("chooses with Enter, closes, and hands focus back to the trigger", async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = libraryMenu();
    await user.click(trigger);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith("reference");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes on Escape and on Tab, returning focus to the trigger and choosing nothing", async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = libraryMenu();
    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.tab();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closes on a press outside without moving focus back", async () => {
    const user = userEvent.setup();
    const { trigger } = libraryMenu();
    await user.click(trigger);
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    await user.click(elsewhere);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(elsewhere).toHaveFocus();
  });
});
