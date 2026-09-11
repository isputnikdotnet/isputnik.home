import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SelectMenu, type SelectMenuOption } from "../src/shared/SelectMenu";

// SelectMenu is the single-choice dropdown (a listbox, not a native <select>):
// the trigger prints the chosen value and is NAMED "label: value", since a value
// alone doesn't say what it is a value of; the popover lists the options with
// the chosen one aria-selected and ticked; choosing reports the value and
// closes; Escape and a press outside close it without choosing.

type Scope = "all" | "mine" | "deleted";

const OPTIONS: SelectMenuOption<Scope>[] = [
  { value: "all", label: "Everything" },
  { value: "mine", label: "Added by me" },
  { value: "deleted", label: "Recently deleted" }
];

function selectMenu(props: Partial<React.ComponentProps<typeof SelectMenu<Scope>>> = {}) {
  const onChange = vi.fn();
  const view = render(
    <div>
      <SelectMenu<Scope> value="mine" options={OPTIONS} label="Show" onChange={onChange} {...props} />
      <button type="button">Elsewhere</button>
    </div>
  );
  return { ...view, onChange };
}

const trigger = () => screen.getByRole("button", { name: /^Show/ });
const listbox = () => screen.getByRole("listbox", { name: "Show" });

describe("SelectMenu", () => {
  it("prints the chosen value and names the trigger 'label: value'", () => {
    selectMenu();
    const button = screen.getByRole("button", { name: "Show: Added by me" });
    expect(button).toHaveTextContent("Added by me");
    expect(button).toHaveAttribute("title", "Show");
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("secondary-button", "select-menu-trigger");
    expect(button).toHaveAttribute("aria-haspopup", "listbox");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).not.toHaveAttribute("aria-controls");
  });

  it("falls back to the first option when the value is not among them", () => {
    selectMenu({ value: "gone" as Scope });
    expect(screen.getByRole("button", { name: "Show: Everything" })).toHaveTextContent("Everything");
  });

  it("appends the caller's class to its root", () => {
    const { container } = selectMenu({ className: "toolbar-select" });
    expect(container.querySelector(".select-menu")).toHaveClass("toolbar-select");
  });

  it("opens a listbox of every option, with the chosen one selected and ticked", async () => {
    const user = userEvent.setup();
    selectMenu();
    await user.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(trigger()).toHaveAttribute("aria-controls", listbox().id);

    const options = within(listbox()).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["Everything", "Added by me", "Recently deleted"]);
    const chosen = within(listbox()).getByRole("option", { name: "Added by me", selected: true });
    expect(chosen).toHaveClass("active");
    expect(chosen.querySelector(".select-menu-check svg")).not.toBeNull();
    const other = within(listbox()).getByRole("option", { name: "Everything" });
    expect(other).toHaveAttribute("aria-selected", "false");
    expect(other.querySelector(".select-menu-check svg")).toBeNull();
  });

  it("reports the chosen value and closes", async () => {
    const user = userEvent.setup();
    const { onChange } = selectMenu();
    await user.click(trigger());
    await user.click(within(listbox()).getByRole("option", { name: "Recently deleted" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("deleted");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("carries the new choice into the trigger", async () => {
    const user = userEvent.setup();
    function Page() {
      const [scope, setScope] = useState<Scope>("all");
      return <SelectMenu value={scope} options={OPTIONS} label="Show" onChange={setScope} />;
    }
    render(<Page />);
    await user.click(screen.getByRole("button", { name: "Show: Everything" }));
    await user.click(screen.getByRole("option", { name: "Recently deleted" }));
    expect(screen.getByRole("button", { name: "Show: Recently deleted" })).toHaveTextContent("Recently deleted");
  });

  it("toggles closed from its own trigger", async () => {
    const user = userEvent.setup();
    selectMenu();
    await user.click(trigger());
    expect(listbox()).toBeInTheDocument();
    await user.click(trigger());
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes on Escape without choosing", async () => {
    const user = userEvent.setup();
    const { onChange } = selectMenu();
    await user.click(trigger());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closes on a press outside, but not on one inside the popover", async () => {
    const user = userEvent.setup();
    const { onChange } = selectMenu();
    await user.click(trigger());
    fireEvent.pointerDown(listbox());
    expect(listbox()).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("opens and chooses from the keyboard", async () => {
    const user = userEvent.setup();
    const { onChange } = selectMenu();
    await user.tab();
    expect(trigger()).toHaveFocus();
    await user.keyboard("{Enter}");
    // The options follow the trigger in the tab order.
    await user.tab();
    expect(within(listbox()).getByRole("option", { name: "Everything" })).toHaveFocus();
    await user.tab();
    await user.keyboard(" ");
    expect(onChange).toHaveBeenCalledWith("mine");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("never submits a surrounding form", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    const onChange = vi.fn();
    render(
      <form onSubmit={onSubmit}>
        <SelectMenu<Scope> value="all" options={OPTIONS} label="Show" onChange={onChange} />
      </form>
    );
    await user.click(trigger());
    await user.click(screen.getByRole("option", { name: "Added by me" }));
    expect(onChange).toHaveBeenCalledWith("mine");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  describe("icons", () => {
    const WITH_ICONS: SelectMenuOption<Scope>[] = [
      { value: "all", label: "Everything", icon: <span data-testid="icon-all" /> },
      { value: "mine", label: "Added by me" },
      { value: "deleted", label: "Recently deleted", icon: <span data-testid="icon-deleted" /> }
    ];

    it("shows the menu's own icon on the trigger only, hidden from assistive tech", async () => {
      const user = userEvent.setup();
      selectMenu({ triggerIcon: <span data-testid="purpose" /> });
      const purpose = within(trigger()).getByTestId("purpose");
      expect(purpose.parentElement).toHaveAttribute("aria-hidden", "true");
      await user.click(trigger());
      expect(within(listbox()).queryByTestId("purpose")).not.toBeInTheDocument();
    });

    it("shows the chosen option's icon on the trigger", () => {
      selectMenu({ options: WITH_ICONS, value: "deleted" });
      expect(within(trigger()).getByTestId("icon-deleted")).toBeInTheDocument();
      expect(within(trigger()).queryByTestId("icon-all")).not.toBeInTheDocument();
    });

    it("gives every row an icon cell once any option has an icon", async () => {
      const user = userEvent.setup();
      selectMenu({ options: WITH_ICONS });
      await user.click(trigger());
      for (const option of within(listbox()).getAllByRole("option")) {
        expect(option).not.toHaveClass("no-icon");
        expect(option.querySelector(".select-menu-option-icon")).not.toBeNull();
      }
    });

    it("marks rows as icon-less when no option has one", async () => {
      const user = userEvent.setup();
      selectMenu();
      await user.click(trigger());
      for (const option of within(listbox()).getAllByRole("option")) {
        expect(option).toHaveClass("no-icon");
        expect(option.querySelector(".select-menu-option-icon")).toBeNull();
      }
    });
  });

  describe("alignment", () => {
    const rect = (left: number, width: number) => ({
      left, right: left + width, width, top: 0, bottom: 44, height: 44, x: left, y: 0, toJSON: () => ({})
    }) as DOMRect;

    // jsdom's window is 1024 wide. The popover measures itself after paint;
    // `root` is where the trigger's right edge sits.
    function place(popoverLeft: number, rootRight: number) {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("select-menu-popover")) return rect(popoverLeft, 220);
        if (this.classList.contains("select-menu")) return rect(rootRight - 180, 180);
        return rect(0, 0);
      });
    }

    it("hangs from the left edge when it fits", async () => {
      const user = userEvent.setup();
      place(400, 580);
      selectMenu();
      await user.click(trigger());
      expect(listbox()).not.toHaveClass("align-right");
    });

    it("flips to the right edge when it would run off the window and the left side has room", async () => {
      const user = userEvent.setup();
      place(900, 1000);
      selectMenu();
      await user.click(trigger());
      expect(listbox()).toHaveClass("align-right");
    });

    it("stays left-aligned when flipping would run off the other side", async () => {
      const user = userEvent.setup();
      place(900, 150);
      selectMenu();
      await user.click(trigger());
      expect(listbox()).not.toHaveClass("align-right");
    });

    it("forgets the flip once closed, so the next open measures afresh", async () => {
      const user = userEvent.setup();
      place(900, 1000);
      selectMenu();
      await user.click(trigger());
      expect(listbox()).toHaveClass("align-right");
      await user.keyboard("{Escape}");

      place(400, 580);
      await user.click(trigger());
      expect(listbox()).not.toHaveClass("align-right");
    });
  });
});
