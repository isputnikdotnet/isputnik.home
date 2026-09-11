import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SortMenu, type SortMenuGroup, type SortOption } from "../src/shared/SortMenu";

// The sort control every browse page wears. Its contract: the trigger always
// names what it is for AND what is chosen (an icon-only trigger, or the toolbar
// below 1100px where CSS drops the text, has nothing else to show it); the menu
// lists the choices as radio items with the current one checked; choosing one
// reports its key and closes; Escape, a press outside, scrolling or resizing
// close it too. From the keyboard, focus goes into the menu on the current
// choice, the arrows walk it, and it comes back to the trigger on the way out.

type SortKey = "recent" | "title" | "author";

const OPTIONS: SortOption<SortKey>[] = [
  { value: "recent", label: "Recently added" },
  { value: "title", label: "Title (A–Z)" },
  { value: "author", label: "Author" }
];

// The single-setting shape's chrome, which is all these tests vary.
type SortMenuProps = {
  value?: SortKey;
  presentation?: "inline" | "icon" | "labelled";
  ariaLabel?: string;
  icon?: React.ReactNode;
  label?: string;
};

function sortMenu(props: SortMenuProps = {}) {
  const onChange = vi.fn();
  const view = render(
    <div>
      <SortMenu<SortKey> value="recent" options={OPTIONS} onChange={onChange} {...props} />
      <button type="button">Elsewhere</button>
    </div>
  );
  return { ...view, onChange };
}

const menu = () => screen.getByRole("menu");

describe("SortMenu", () => {
  describe("presentations", () => {
    it("inline: reads 'Sort by' then the chosen label, and names the trigger Sort", () => {
      const { container } = sortMenu();
      expect(container).toHaveTextContent(/^Sort byRecently added/);
      const trigger = screen.getByRole("button", { name: "Sort" });
      expect(trigger).toHaveTextContent("Recently added");
      expect(trigger).toHaveAttribute("type", "button");
      expect(trigger).toHaveAttribute("aria-haspopup", "menu");
      expect(trigger).toHaveAttribute("aria-expanded", "false");
    });

    it("labelled: shows the chosen value as the label, and names both in the accessible name and tooltip", () => {
      sortMenu({ presentation: "labelled", value: "title" });
      const trigger = screen.getByRole("button", { name: "Sort: Title (A–Z)" });
      expect(trigger).toHaveAttribute("title", "Sort: Title (A–Z)");
      // The visible text is in the span CSS hides below 1100px — the accessible
      // name above is what keeps the icon-only trigger meaningful there.
      const text = trigger.querySelector(".toolbar-label");
      expect(text).toHaveTextContent("Title (A–Z)");
      expect(trigger.closest(".audiobook-sort-control")).toHaveClass("labelled");
    });

    it("labelled with a fixed label: prints the label but still names the value", () => {
      sortMenu({ presentation: "labelled", label: "View", ariaLabel: "View" });
      const trigger = screen.getByRole("button", { name: "View: Recently added" });
      expect(trigger.querySelector(".toolbar-label")).toHaveTextContent("View");
      expect(trigger.querySelector(".toolbar-label")).not.toHaveTextContent("Recently added");
    });

    it("icon: a square with no text, named and titled with the value", () => {
      sortMenu({ presentation: "icon", value: "author" });
      const trigger = screen.getByRole("button", { name: "Sort: Author" });
      expect(trigger).toHaveAttribute("title", "Sort: Author");
      expect(trigger.textContent).toBe("");
      expect(trigger.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      expect(trigger.closest(".audiobook-sort-control")).toHaveClass("compact");
    });

    it("uses a custom icon in place of the sort glyph", () => {
      sortMenu({ presentation: "icon", icon: <span data-testid="custom-glyph" /> });
      expect(within(screen.getByRole("button", { name: "Sort: Recently added" })).getByTestId("custom-glyph")).toBeInTheDocument();
    });

    it("uses the caller's aria label for both the trigger and the menu", async () => {
      const user = userEvent.setup();
      sortMenu({ presentation: "labelled", ariaLabel: "Sort books" });
      await user.click(screen.getByRole("button", { name: "Sort books: Recently added" }));
      expect(screen.getByRole("menu", { name: "Sort books" })).toBeInTheDocument();
    });
  });

  it("opens a menu listing every option, with the current one marked", async () => {
    const user = userEvent.setup();
    sortMenu({ value: "title" });
    const trigger = screen.getByRole("button", { name: "Sort" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const items = within(menu()).getAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual(["Recently added", "Title (A–Z)", "Author"]);
    expect(within(menu()).getByRole("menuitemradio", { name: "Title (A–Z)" })).toHaveClass("active");
    expect(within(menu()).getByRole("menuitemradio", { name: "Recently added" })).not.toHaveClass("active");
    // Checked for a screen reader too, not only by the class that tints it.
    expect(within(menu()).getByRole("menuitemradio", { name: "Title (A–Z)", checked: true })).toBeInTheDocument();
    expect(within(menu()).getAllByRole("menuitemradio", { checked: true })).toHaveLength(1);
    expect(within(menu()).getByRole("menuitemradio", { name: "Author" })).toHaveAttribute("aria-checked", "false");
    expect(menu()).toHaveAccessibleName("Sort");
  });

  it("portals the menu to <body>, out of the toolbar that would clip it", async () => {
    const user = userEvent.setup();
    const { container } = sortMenu({ presentation: "labelled" });
    await user.click(screen.getByRole("button", { name: /^Sort:/ }));
    expect(container).not.toContainElement(menu());
    expect(menu().parentElement).toBe(document.body);
    expect(menu().style.position).toBe("fixed");
  });

  it("reports the chosen key and closes", async () => {
    const user = userEvent.setup();
    const { onChange } = sortMenu();
    await user.click(screen.getByRole("button", { name: "Sort" }));
    await user.click(within(menu()).getByRole("menuitemradio", { name: "Author" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("author");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sort" })).toHaveAttribute("aria-expanded", "false");
  });

  it("carries the new choice into the trigger's label", async () => {
    const user = userEvent.setup();
    function Page() {
      const [sort, setSort] = useState<SortKey>("recent");
      return <SortMenu value={sort} options={OPTIONS} onChange={setSort} presentation="labelled" />;
    }
    render(<Page />);
    await user.click(screen.getByRole("button", { name: "Sort: Recently added" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Title (A–Z)" }));
    const trigger = screen.getByRole("button", { name: "Sort: Title (A–Z)" });
    expect(trigger).toHaveTextContent("Title (A–Z)");

    await user.click(trigger);
    expect(screen.getByRole("menuitemradio", { name: "Title (A–Z)" })).toHaveClass("active");
  });

  it("closes again from its own trigger", async () => {
    const user = userEvent.setup();
    sortMenu();
    const trigger = screen.getByRole("button", { name: "Sort" });
    await user.click(trigger);
    expect(menu()).toBeInTheDocument();
    await user.click(trigger);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on Escape without choosing", async () => {
    const user = userEvent.setup();
    const { onChange } = sortMenu();
    await user.click(screen.getByRole("button", { name: "Sort" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closes on a press outside, but not on one inside the menu", async () => {
    const user = userEvent.setup();
    const { onChange } = sortMenu();
    await user.click(screen.getByRole("button", { name: "Sort" }));
    fireEvent.mouseDown(menu());
    expect(menu()).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closes when the page scrolls or the window resizes, rather than drift from its trigger", async () => {
    const user = userEvent.setup();
    sortMenu();
    const trigger = screen.getByRole("button", { name: "Sort" });

    await user.click(trigger);
    fireEvent.scroll(document);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(trigger);
    fireEvent(window, new Event("resize"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens from the keyboard, and a focused option chooses on Enter", async () => {
    const user = userEvent.setup();
    const { onChange } = sortMenu();
    await user.tab();
    expect(screen.getByRole("button", { name: "Sort" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(menu()).toBeInTheDocument();
    within(menu()).getByRole("menuitemradio", { name: "Title (A–Z)" }).focus();
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("title");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  describe("keyboard", () => {
    const item = (name: string) => within(menu()).getByRole("menuitemradio", { name });

    it("moves focus into the menu on open, onto the current choice", async () => {
      const user = userEvent.setup();
      sortMenu({ value: "title" });
      await user.click(screen.getByRole("button", { name: "Sort" }));
      expect(item("Title (A–Z)")).toHaveFocus();
    });

    it("walks the choices with the arrow keys, wrapping at both ends, and jumps with Home/End", async () => {
      const user = userEvent.setup();
      sortMenu({ value: "recent" });
      await user.click(screen.getByRole("button", { name: "Sort" }));
      expect(item("Recently added")).toHaveFocus();
      await user.keyboard("{ArrowDown}");
      expect(item("Title (A–Z)")).toHaveFocus();
      await user.keyboard("{ArrowDown}{ArrowDown}");
      expect(item("Recently added")).toHaveFocus();
      await user.keyboard("{ArrowUp}");
      expect(item("Author")).toHaveFocus();
      await user.keyboard("{Home}");
      expect(item("Recently added")).toHaveFocus();
      await user.keyboard("{End}");
      expect(item("Author")).toHaveFocus();
    });

    it("chooses the focused item with Enter and hands focus back to the trigger", async () => {
      const user = userEvent.setup();
      const { onChange } = sortMenu();
      const trigger = screen.getByRole("button", { name: "Sort" });
      await user.click(trigger);
      await user.keyboard("{ArrowDown}{Enter}");
      expect(onChange).toHaveBeenCalledWith("title");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });

    it("closes on Escape and returns focus to the trigger, choosing nothing", async () => {
      const user = userEvent.setup();
      const { onChange } = sortMenu();
      const trigger = screen.getByRole("button", { name: "Sort" });
      await user.click(trigger);
      await user.keyboard("{ArrowDown}{Escape}");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
      expect(onChange).not.toHaveBeenCalled();
    });

    it("closes on Tab rather than leave focus in a menu that is about to vanish", async () => {
      const user = userEvent.setup();
      const { onChange } = sortMenu();
      const trigger = screen.getByRole("button", { name: "Sort" });
      await user.click(trigger);
      await user.tab();
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
      expect(onChange).not.toHaveBeenCalled();
    });

    it("walks every group's choices as one list, starting on the first checked one", async () => {
      const user = userEvent.setup();
      const groups: SortMenuGroup[] = [
        { heading: "Tile size", value: "large", options: [{ value: "small", label: "Small" }, { value: "large", label: "Large" }], onChange: vi.fn() },
        { heading: "Sections", value: "none", options: [{ value: "none", label: "No sections" }, { value: "month", label: "By month" }], onChange: vi.fn() }
      ];
      render(<SortMenu groups={groups} presentation="labelled" label="View" ariaLabel="View" />);
      await user.click(screen.getByRole("button", { name: /^View:/ }));
      expect(item("Large")).toHaveFocus();
      await user.keyboard("{ArrowDown}");
      expect(item("No sections")).toHaveFocus();
    });
  });

  describe("placement", () => {
    const rect = (left: number, width: number) => ({
      left, right: left + width, width, top: 100, bottom: 144, height: 44, x: left, y: 100, toJSON: () => ({})
    }) as DOMRect;

    it("hangs 8px under the trigger from its left edge when there is room", async () => {
      const user = userEvent.setup();
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect(100, 120));
      sortMenu({ presentation: "labelled" });
      await user.click(screen.getByRole("button", { name: /^Sort:/ }));
      expect(menu().style.top).toBe("152px");
      expect(menu().style.left).toBe("100px");
      expect(menu().style.right).toBe("");
      expect(menu().style.minWidth).toBe("120px");
    });

    it("hangs from the trigger's right edge at the end of a toolbar, where a left-anchored menu would run off-screen", async () => {
      const user = userEvent.setup();
      // jsdom's window is 1024 wide; a trigger at 950 leaves 74px on its right.
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect(950, 44));
      sortMenu({ presentation: "icon" });
      await user.click(screen.getByRole("button", { name: /^Sort:/ }));
      expect(menu().style.left).toBe("");
      expect(menu().style.right).toBe(`${window.innerWidth - 994}px`);
    });
  });

  describe("with several settings in groups", () => {
    function viewMenu() {
      const onSize = vi.fn();
      const onSections = vi.fn();
      const groups: SortMenuGroup[] = [
        {
          heading: "Tile size",
          value: "large",
          options: [{ value: "small", label: "Small" }, { value: "large", label: "Large" }],
          onChange: onSize
        },
        {
          heading: "Sections",
          value: "month",
          options: [{ value: "none", label: "No sections" }, { value: "month", label: "By month" }],
          onChange: onSections
        }
      ];
      render(<SortMenu groups={groups} presentation="labelled" label="View" ariaLabel="View" />);
      return { onSize, onSections };
    }

    it("names every current choice on the trigger while printing the fixed label", () => {
      viewMenu();
      const trigger = screen.getByRole("button", { name: "View: Large · By month" });
      expect(trigger.querySelector(".toolbar-label")).toHaveTextContent(/^View$/);
    });

    it("lists each setting as its own labelled group with its current choice marked", async () => {
      const user = userEvent.setup();
      viewMenu();
      await user.click(screen.getByRole("button", { name: /^View:/ }));
      const size = within(menu()).getByRole("group", { name: "Tile size" });
      const sections = within(menu()).getByRole("group", { name: "Sections" });
      expect(within(size).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["Small", "Large"]);
      expect(within(size).getByRole("menuitemradio", { name: "Large" })).toHaveClass("active");
      expect(within(sections).getByRole("menuitemradio", { name: "By month" })).toHaveClass("active");
      // The visible heading is decoration; the group's own label carries it.
      expect(within(size).getByText("Tile size")).toHaveAttribute("aria-hidden", "true");
    });

    it("reports a choice only to the group it belongs to", async () => {
      const user = userEvent.setup();
      const { onSize, onSections } = viewMenu();
      await user.click(screen.getByRole("button", { name: /^View:/ }));
      await user.click(within(menu()).getByRole("menuitemradio", { name: "No sections" }));
      expect(onSections).toHaveBeenCalledWith("none");
      expect(onSize).not.toHaveBeenCalled();
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
  });
});
