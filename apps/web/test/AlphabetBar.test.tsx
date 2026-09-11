import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AlphabetBar } from "../src/shared/AlphabetBar";
import { ALPHABETS, OTHER_BUCKET, alphabetOf } from "../src/shared/alphabets";

// The A–Z strip under every browse toolbar. It draws the server's `letters`
// facet and nothing more: a letter the scope has no titles under is disabled
// (never hidden — the row must not reflow under the pointer), the chosen letter
// is pressed, pressing it again or "All" clears it, and the English | Русский
// toggle exists only when the scope has titles in both scripts.

const LATIN = ALPHABETS.find((alphabet) => alphabet.id === "latin")!.letters;
const CYRILLIC = ALPHABETS.find((alphabet) => alphabet.id === "cyrillic")!.letters;

function bar(props: Partial<React.ComponentProps<typeof AlphabetBar>> = {}) {
  const onChange = vi.fn();
  const view = render(<AlphabetBar available={["A", "C", "M"]} value={null} onChange={onChange} {...props} />);
  return { ...view, onChange };
}

const letters = () => within(screen.getByRole("group", { name: "Filter by letter" }));
const letter = (name: string) => letters().getByRole("button", { name });

describe("alphabets", () => {
  it("names each letter's alphabet, and has no alphabet for the # bucket", () => {
    expect(alphabetOf("Q")?.id).toBe("latin");
    expect(alphabetOf("Ё")?.id).toBe("cyrillic");
    expect(alphabetOf(OTHER_BUCKET)).toBeNull();
    expect(alphabetOf("7")).toBeNull();
  });

  it("gives Ё a letter of its own, right after Е", () => {
    expect(CYRILLIC.indexOf("Ё")).toBe(CYRILLIC.indexOf("Е") + 1);
    expect(CYRILLIC).toHaveLength(33);
    expect(LATIN).toHaveLength(26);
  });

  it("never shares a letter between two alphabets", () => {
    // Latin A and Cyrillic А look the same but are different code points; a
    // shared entry would make alphabetOf pick the wrong row.
    const all = ALPHABETS.flatMap((alphabet) => alphabet.letters);
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain(OTHER_BUCKET);
  });
});

describe("AlphabetBar", () => {
  it("draws no strip at all when nothing is indexed yet", () => {
    const { container } = bar({ available: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it("shows All, the whole Latin row and #, with no script toggle for a Latin-only scope", () => {
    bar();
    const buttons = letters().getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["All", ...LATIN, "#"]);
    expect(screen.queryByRole("group", { name: "Alphabet" })).not.toBeInTheDocument();
  });

  it("disables the letters the scope holds nothing under, rather than hiding them", () => {
    bar({ available: ["A", "C", "M"] });
    expect(letter("A")).toBeEnabled();
    expect(letter("C")).toBeEnabled();
    expect(letter("M")).toBeEnabled();
    expect(letter("B")).toBeDisabled();
    expect(letter("Z")).toBeDisabled();
    expect(letter("All")).toBeEnabled();
  });

  it("names the # bucket for a screen reader and enables it only when there are such titles", () => {
    const { rerender, onChange } = bar();
    expect(letter("Starting with a number or symbol")).toHaveTextContent("#");
    expect(letter("Starting with a number or symbol")).toBeDisabled();

    rerender(<AlphabetBar available={["A", OTHER_BUCKET]} value={null} onChange={onChange} />);
    expect(letter("Starting with a number or symbol")).toBeEnabled();
  });

  it("uses the caller's label for the strip when given one", () => {
    bar({ ariaLabel: "Filter authors by surname" });
    expect(screen.getByRole("group", { name: "Filter authors by surname" })).toBeInTheDocument();
  });

  it("presses All while nothing is chosen", () => {
    bar();
    expect(letter("All")).toHaveAttribute("aria-pressed", "true");
    expect(letter("All")).toHaveClass("is-active");
    expect(letter("A")).toHaveAttribute("aria-pressed", "false");
  });

  it("presses the chosen letter and only that one", () => {
    bar({ value: "C" });
    expect(letter("C")).toHaveAttribute("aria-pressed", "true");
    expect(letter("C")).toHaveClass("is-active");
    expect(letter("All")).toHaveAttribute("aria-pressed", "false");
    expect(letters().getAllByRole("button", { pressed: true })).toEqual([letter("C")]);
  });

  it("chooses a letter on click", async () => {
    const user = userEvent.setup();
    const { onChange } = bar();
    await user.click(letter("M"));
    expect(onChange).toHaveBeenCalledWith("M");
  });

  it("clears the filter when the chosen letter is pressed again, or All is", async () => {
    const user = userEvent.setup();
    const { onChange } = bar({ value: "C" });
    await user.click(letter("C"));
    expect(onChange).toHaveBeenLastCalledWith(null);
    await user.click(letter("All"));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("does nothing for a disabled letter", async () => {
    const user = userEvent.setup();
    const { onChange } = bar();
    await user.click(letter("B"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("chooses the # bucket like any letter", async () => {
    const user = userEvent.setup();
    const { onChange } = bar({ available: ["A", OTHER_BUCKET] });
    await user.click(letter("Starting with a number or symbol"));
    expect(onChange).toHaveBeenCalledWith(OTHER_BUCKET);
  });

  it("is operable from the keyboard, skipping the disabled letters", async () => {
    const user = userEvent.setup();
    const { onChange } = bar({ available: ["C"] });
    await user.tab();
    expect(letter("All")).toHaveFocus();
    await user.tab();
    expect(letter("C")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("C");
  });

  it("follows a controlled value, as the page's ?letter= does", async () => {
    const user = userEvent.setup();
    function Page() {
      const [value, setValue] = useState<string | null>(null);
      return (
        <>
          <AlphabetBar available={["A", "C"]} value={value} onChange={setValue} />
          <output>{value ?? "everything"}</output>
        </>
      );
    }
    render(<Page />);
    await user.click(letter("C"));
    expect(screen.getByRole("status")).toHaveTextContent("C");
    expect(letter("C")).toHaveAttribute("aria-pressed", "true");
    await user.click(letter("C"));
    expect(screen.getByRole("status")).toHaveTextContent("everything");
    expect(letter("All")).toHaveAttribute("aria-pressed", "true");
  });

  describe("with titles in two scripts", () => {
    const BOTH = ["A", "M", "Д", "Ё"];
    const scripts = () => within(screen.getByRole("group", { name: "Alphabet" }));

    it("offers the script toggle, starting on the first alphabet", () => {
      bar({ available: BOTH });
      const english = scripts().getByRole("button", { name: "English" });
      const russian = scripts().getByRole("button", { name: "Русский" });
      expect(english).toHaveTextContent("EN");
      expect(russian).toHaveTextContent("RU");
      expect(english).toHaveAttribute("aria-pressed", "true");
      expect(russian).toHaveAttribute("aria-pressed", "false");
      expect(letter("M")).toBeInTheDocument();
      expect(letters().queryByRole("button", { name: "Д" })).not.toBeInTheDocument();
    });

    it("swaps the row to the other alphabet, keeping All and #", async () => {
      const user = userEvent.setup();
      const { onChange } = bar({ available: BOTH });
      await user.click(scripts().getByRole("button", { name: "Русский" }));

      expect(scripts().getByRole("button", { name: "Русский" })).toHaveAttribute("aria-pressed", "true");
      // The toggle sits inside the strip's group; the row is everything else.
      const toggle = scripts().getAllByRole("button");
      const shown = letters().getAllByRole("button").filter((button) => !toggle.includes(button));
      expect(shown.map((button) => button.textContent)).toEqual(["All", ...CYRILLIC, "#"]);
      expect(letter("Д")).toBeEnabled();
      expect(letter("Ё")).toBeEnabled();
      expect(letter("Б")).toBeDisabled();
      // Nothing was chosen, so there was nothing to clear.
      expect(onChange).not.toHaveBeenCalled();
    });

    it("clears a letter of the alphabet being left", async () => {
      const user = userEvent.setup();
      const { onChange } = bar({ available: BOTH, value: "M" });
      await user.click(scripts().getByRole("button", { name: "Русский" }));
      expect(onChange).toHaveBeenCalledWith(null);
    });

    it("keeps # when switching, since both rows end in it and it holds the same titles", async () => {
      const user = userEvent.setup();
      const available = [...BOTH, OTHER_BUCKET];
      const { onChange, rerender } = bar({ available, value: OTHER_BUCKET });
      expect(letter("Starting with a number or symbol")).toHaveAttribute("aria-pressed", "true");

      await user.click(scripts().getByRole("button", { name: "Русский" }));
      expect(onChange).not.toHaveBeenCalled();
      expect(scripts().getByRole("button", { name: "Русский" })).toHaveAttribute("aria-pressed", "true");
      expect(letter("Starting with a number or symbol")).toHaveAttribute("aria-pressed", "true");
      expect(letter("Д")).toBeInTheDocument();

      // …and back again, still on #.
      await user.click(scripts().getByRole("button", { name: "English" }));
      rerender(<AlphabetBar available={available} value={OTHER_BUCKET} onChange={onChange} />);
      expect(onChange).not.toHaveBeenCalled();
      expect(letter("M")).toBeInTheDocument();
      expect(letter("Starting with a number or symbol")).toHaveAttribute("aria-pressed", "true");
    });

    it("keeps the chosen letter when its own alphabet is picked again", async () => {
      const user = userEvent.setup();
      const { onChange } = bar({ available: BOTH, value: "M" });
      await user.click(scripts().getByRole("button", { name: "English" }));
      expect(onChange).not.toHaveBeenCalled();
    });

    it("shows the chosen letter's alphabet whatever the toggle last said", () => {
      // Landing on ?letter=Д must show the Cyrillic row.
      bar({ available: BOTH, value: "Д" });
      expect(scripts().getByRole("button", { name: "Русский" })).toHaveAttribute("aria-pressed", "true");
      expect(letter("Д")).toHaveAttribute("aria-pressed", "true");
    });
  });

  it("shows the Cyrillic row alone for a Cyrillic-only scope", () => {
    bar({ available: ["Д", "Я"] });
    expect(screen.queryByRole("group", { name: "Alphabet" })).not.toBeInTheDocument();
    expect(letter("Д")).toBeEnabled();
    expect(letters().queryByRole("button", { name: "A" })).not.toBeInTheDocument();
  });
});
