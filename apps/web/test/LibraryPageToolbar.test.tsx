import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAppLanguage } from "../src/i18n";
import { AlphabetBar } from "../src/shared/AlphabetBar";
import { Button } from "../src/shared/Button";
import { LibraryPageToolbar } from "../src/shared/LibraryPageToolbar";
import { SortMenu } from "../src/shared/SortMenu";

// The one toolbar every browse page wears. Pages fill slots rather than arrange
// their own row: scope on the left, tools on the right, the A–Z strip as a second
// row inside the same card. The rule it exists to enforce: a selection REPLACES
// the tools inside this card — never a second bar under it — so nothing below
// the toolbar moves when edit mode starts, and the card pins while selecting.

const card = (container: HTMLElement) => container.querySelector(".library-toolbar") as HTMLElement;
const rows = (container: HTMLElement) => Array.from(card(container).children) as HTMLElement[];

function tools() {
  return (
    <>
      <Button variant="secondary">Filter</Button>
      <Button variant="secondary">Select</Button>
    </>
  );
}

describe("LibraryPageToolbar", () => {
  it("lays scope and tools out in one row", () => {
    const { container } = render(
      <LibraryPageToolbar scope={<Button>All libraries</Button>} tools={tools()} />
    );
    expect(card(container)).not.toHaveClass("is-selecting");
    expect(rows(container)).toHaveLength(1);
    const row = rows(container)[0];
    expect(row).toHaveClass("library-toolbar-row");
    expect(within(row.querySelector(".library-toolbar-scope") as HTMLElement).getByRole("button", { name: "All libraries" })).toBeInTheDocument();
    const toolSlot = row.querySelector(".library-toolbar-tools") as HTMLElement;
    expect(within(toolSlot).getAllByRole("button").map((button) => button.textContent)).toEqual(["Filter", "Select"]);
  });

  it("keeps the scope slot even when empty, so the tools stay on the right", () => {
    const { container } = render(<LibraryPageToolbar tools={tools()} />);
    const scope = container.querySelector(".library-toolbar-scope");
    expect(scope).toBeInTheDocument();
    expect(scope).toBeEmptyDOMElement();
  });

  it("renders no tools container when the page has no tools", () => {
    const { container } = render(<LibraryPageToolbar scope="Albums" />);
    expect(container.querySelector(".library-toolbar-tools")).toBeNull();
  });

  it("appends the caller's class to the card", () => {
    const { container } = render(<LibraryPageToolbar tools={tools()} className="gallery-toolbar" />);
    expect(card(container)).toHaveClass("library-toolbar", "gallery-toolbar");
  });

  it("draws the strip as a second row inside the same card", () => {
    const { container } = render(
      <LibraryPageToolbar tools={tools()} strip={<AlphabetBar available={["A"]} value={null} onChange={vi.fn()} />} />
    );
    expect(rows(container)).toHaveLength(2);
    const strip = rows(container)[1];
    expect(strip).toHaveClass("library-toolbar-strip");
    expect(within(strip).getByRole("group", { name: "Filter by letter" })).toBeInTheDocument();
  });

  it.each([null, undefined, false, ""])("draws no strip row at all for a falsy strip (%j)", (strip) => {
    const { container } = render(<LibraryPageToolbar tools={tools()} strip={strip} />);
    expect(rows(container)).toHaveLength(1);
    expect(container.querySelector(".library-toolbar-strip")).toBeNull();
  });

  describe("with an alphabet", () => {
    afterEach(() => {
      localStorage.removeItem("isputnik.alphabetStrip");
    });

    it("puts the A–Z menu first in the tools, and folds the strip away", () => {
      const { container } = render(
        <LibraryPageToolbar tools={tools()} alphabet={{ available: ["A", "D"], value: null, onChange: vi.fn() }} />
      );
      const slot = container.querySelector(".library-toolbar-tools") as HTMLElement;
      expect(within(slot).getAllByRole("button").map((button) => button.textContent)).toEqual(["A–Z", "Filter", "Select"]);
      // Still rendered for the phone, which always has the strip; folded on a wide screen.
      expect(container.querySelector(".library-toolbar-strip")).toHaveClass("is-alphabet", "is-folded");
      expect(card(container)).not.toHaveClass("has-strip");
    });

    it("picks a letter from the menu and prints it on the button", async () => {
      const user = userEvent.setup();
      function Page() {
        const [letter, setLetter] = useState<string | null>(null);
        return <LibraryPageToolbar alphabet={{ available: ["A", "D"], value: letter, onChange: setLetter }} />;
      }
      const { container } = render(<Page />);
      const trigger = container.querySelector(".alphabet-menu-trigger") as HTMLElement;
      await user.click(trigger);
      const menu = screen.getByRole("dialog", { name: "Filter by letter" });
      // Letters with nothing behind them stay in place, disabled.
      expect(within(menu).getByRole("button", { name: "B" })).toBeDisabled();
      await user.click(within(menu).getByRole("button", { name: "D" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(trigger).toHaveTextContent("D");
      expect(trigger).toHaveClass("is-filtered");
    });

    it("shows the strip when asked, and remembers it", async () => {
      const user = userEvent.setup();
      const { container, unmount } = render(
        <LibraryPageToolbar alphabet={{ available: ["A"], value: null, onChange: vi.fn() }} />
      );
      await user.click(container.querySelector(".alphabet-menu-trigger") as HTMLElement);
      await user.click(screen.getByRole("button", { name: "Show the letter strip" }));
      expect(card(container)).toHaveClass("has-strip");
      expect(container.querySelector(".library-toolbar-strip")).not.toHaveClass("is-folded");
      unmount();

      const again = render(<LibraryPageToolbar alphabet={{ available: ["A"], value: null, onChange: vi.fn() }} />);
      expect(card(again.container)).toHaveClass("has-strip");
      await user.click(again.container.querySelector(".alphabet-menu-trigger") as HTMLElement);
      await user.click(screen.getByRole("button", { name: "Hide the letter strip" }));
      expect(card(again.container)).not.toHaveClass("has-strip");
    });

    it("draws no menu while the library has no letters yet", () => {
      const { container } = render(<LibraryPageToolbar tools={tools()} alphabet={{ available: [], value: null, onChange: vi.fn() }} />);
      expect(container.querySelector(".alphabet-menu-trigger")).toBeNull();
      expect(container.querySelector(".library-toolbar-strip")).toBeNull();
    });
  });

  describe("while selecting", () => {
    it("replaces the tools with the count and the selection's actions, inside the same row", () => {
      const { container } = render(
        <LibraryPageToolbar
          scope={<Button>All libraries</Button>}
          tools={tools()}
          selection={{
            count: 3,
            actions: (
              <>
                <Button variant="icon" aria-label="Add to collection">+</Button>
                <Button variant="secondary">Done</Button>
              </>
            )
          }}
        />
      );
      expect(card(container)).toHaveClass("is-selecting");
      // Still one row: no second bar appears under the card.
      expect(rows(container)).toHaveLength(1);
      expect(container.querySelectorAll(".library-toolbar-tools")).toHaveLength(1);

      const slot = container.querySelector(".library-toolbar-tools") as HTMLElement;
      expect(slot).toHaveClass("is-selection");
      expect(within(slot).getByText("3 selected")).toHaveClass("library-toolbar-count");
      expect(within(slot).getByRole("button", { name: "Add to collection" })).toBeInTheDocument();
      expect(within(slot).getByRole("button", { name: "Done" })).toBeInTheDocument();

      // The page's own tools are gone, the scope is not.
      expect(screen.queryByRole("button", { name: "Filter" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Select" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "All libraries" })).toBeInTheDocument();
    });

    it("counts with the plural rules, one included", () => {
      const { rerender } = render(<LibraryPageToolbar selection={{ count: 1, actions: null }} />);
      expect(screen.getByText("1 selected")).toBeInTheDocument();
      rerender(<LibraryPageToolbar selection={{ count: 0, actions: null }} />);
      // Zero is still a selection in progress — the page just started one.
      expect(screen.getByText("0 selected")).toBeInTheDocument();
    });

    it("shows the selection even when the page has no tools of its own", () => {
      const { container } = render(<LibraryPageToolbar selection={{ count: 2, actions: <Button>Done</Button> }} />);
      expect(container.querySelector(".library-toolbar-tools.is-selection")).toBeInTheDocument();
      expect(screen.getByText("2 selected")).toBeInTheDocument();
    });

    it("keeps the strip under it, so nothing below the toolbar moves", () => {
      const { container } = render(
        <LibraryPageToolbar
          tools={tools()}
          selection={{ count: 1, actions: null }}
          strip={<AlphabetBar available={["A"]} value={null} onChange={vi.fn()} />}
        />
      );
      expect(rows(container)).toHaveLength(2);
      expect(screen.getByRole("group", { name: "Filter by letter" })).toBeInTheDocument();
    });

    it("gives the tools back when the selection ends, as a page toggles edit mode", async () => {
      const user = userEvent.setup();
      function Page() {
        const [selecting, setSelecting] = useState(false);
        return (
          <LibraryPageToolbar
            scope={<span>Audiobooks</span>}
            tools={
              <>
                <SortMenu value="title" options={[{ value: "title", label: "Title (A–Z)" }]} onChange={vi.fn()} presentation="labelled" />
                <Button onClick={() => setSelecting(true)}>Select</Button>
              </>
            }
            selection={selecting ? { count: 0, actions: <Button onClick={() => setSelecting(false)}>Done</Button> } : null}
          />
        );
      }
      const { container } = render(<Page />);
      await user.click(screen.getByRole("button", { name: "Select" }));
      expect(card(container)).toHaveClass("is-selecting");
      expect(screen.queryByRole("button", { name: "Sort: Title (A–Z)" })).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Done" }));
      expect(card(container)).not.toHaveClass("is-selecting");
      expect(screen.getByRole("button", { name: "Sort: Title (A–Z)" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Select" })).toBeInTheDocument();
      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    });
  });

  describe("in Russian", () => {
    afterEach(async () => {
      await setAppLanguage("en");
    });

    it("counts with Russian's plural forms, not a hand-built one", async () => {
      await setAppLanguage("ru");
      const { rerender } = render(<LibraryPageToolbar selection={{ count: 1, actions: null }} />);
      expect(screen.getByText("1 выбран")).toBeInTheDocument();
      rerender(<LibraryPageToolbar selection={{ count: 5, actions: null }} />);
      expect(screen.getByText("5 выбрано")).toBeInTheDocument();
      // 21 takes the "one" form in Russian — English rules would say "other".
      rerender(<LibraryPageToolbar selection={{ count: 21, actions: null }} />);
      expect(screen.getByText("21 выбран")).toBeInTheDocument();
    });
  });
});
