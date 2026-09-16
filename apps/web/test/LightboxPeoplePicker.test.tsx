import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LightboxPeoplePicker } from "../src/features/gallery/LightboxPeoplePicker";
import type { GalleryPerson } from "../src/features/gallery/types";

// The lightbox's person picker: who is offered, in what order, and what a pick
// or Enter hands back — a known person by id, or a name for a new one.

const person = (id: string, name: string, faceCount: number): GalleryPerson => ({ id, name, faceCount, coverUrl: null });

const people = [
  person("p1", "Anna", 3),
  person("p2", "Mariana", 40),
  person("p3", "Maria", 12),
  person("p4", "Boris", 25),
  person("p5", "", 9)
];

function setup(tagged = [{ id: "p4", name: "Boris" }]) {
  const onPick = vi.fn(async () => true);
  const onClose = vi.fn();
  render(<LightboxPeoplePicker people={people} tagged={tagged} busy={false} onPick={onPick} onClose={onClose} />);
  // Each row as it reads: the name, then its photo count (the avatar's initial is decoration).
  const names = () => {
    const list = screen.queryByRole("listbox");
    if (!list) return [];
    return within(list).getAllByRole("option").map((row) =>
      [...row.querySelectorAll(".lb-suggest-name, .lb-suggest-detail")].map((part) => part.textContent).join(""));
  };
  return { onPick, onClose, names };
}

describe("LightboxPeoplePicker", () => {
  it("offers the most-seen named people first, leaving out who is already tagged", () => {
    const { names } = setup();
    expect(names()).toEqual(["Mariana40 photos", "Maria12 photos", "Anna3 photos"]);
  });

  it("puts names starting with the typed text ahead of names containing it", async () => {
    const { names } = setup([]);
    await userEvent.type(screen.getByRole("combobox"), "ari");
    expect(names()).toEqual(["Mariana40 photos", "Maria12 photos", "Add “ari” as a new person"]);
    await userEvent.clear(screen.getByRole("combobox"));
    await userEvent.type(screen.getByRole("combobox"), "mar");
    expect(names()[0]).toBe("Mariana40 photos");
  });

  it("picks the highlighted row with Enter, moved by the arrow keys", async () => {
    const { onPick } = setup();
    const box = screen.getByRole("combobox");
    await userEvent.type(box, "mar");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onPick).toHaveBeenCalledWith({ personId: "p3" });
    expect(box).toHaveValue("");
  });

  it("offers a name nobody has as a new person, and not one that exists", async () => {
    const { onPick, names } = setup();
    const box = screen.getByRole("combobox");
    await userEvent.type(box, "boris");
    expect(names()).toEqual([]);
    await userEvent.clear(box);
    await userEvent.type(box, "Grandpa Ivan");
    expect(names()).toEqual(["Add “Grandpa Ivan” as a new person"]);
    await userEvent.click(screen.getByRole("option"));
    expect(onPick).toHaveBeenCalledWith({ name: "Grandpa Ivan" });
  });

  it("clears the text on the first Escape and closes on the second", async () => {
    const { onClose } = setup();
    const box = screen.getByRole("combobox");
    await userEvent.type(box, "an{Escape}");
    expect(box).toHaveValue("");
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
