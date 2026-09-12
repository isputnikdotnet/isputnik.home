import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ActionMenu, type ActionMenuItem } from "../src/shared/ActionMenu";

// ActionMenu is a menu of one-shot commands, so its entries are plain menuitems
// (nothing is "chosen"). From the keyboard it behaves like SortMenu
// (useMenuKeyboard): focus opens on the first action that can run, the arrows
// walk the enabled ones and wrap, and Escape, Tab or running an action hand
// focus back to the trigger.

function actionMenu(trigger: "button" | "icon" = "button") {
  const onRename = vi.fn();
  const onMove = vi.fn();
  const onDelete = vi.fn();
  const items: ActionMenuItem[] = [
    { key: "rename", label: "Rename", onSelect: onRename },
    { key: "share", label: "Share", disabledReason: "Sharing is off", onSelect: vi.fn() },
    { key: "move", label: "Move", onSelect: onMove },
    { key: "delete", label: "Delete", danger: true, onSelect: onDelete }
  ];
  render(
    <div>
      <ActionMenu label="Actions" items={items} trigger={trigger} />
      <button type="button">Elsewhere</button>
    </div>
  );
  return { onRename, onMove, onDelete, triggerButton: screen.getByRole("button", { name: "Actions" }) };
}

const menu = () => screen.getByRole("menu", { name: "Actions" });
const item = (name: string) => within(menu()).getByRole("menuitem", { name });

describe("ActionMenu", () => {
  it("lists the actions as menuitems and points the trigger at the open menu", async () => {
    const user = userEvent.setup();
    const { triggerButton } = actionMenu();
    expect(triggerButton).toHaveAttribute("aria-haspopup", "menu");
    expect(triggerButton).toHaveAttribute("aria-expanded", "false");
    await user.click(triggerButton);
    expect(triggerButton).toHaveAttribute("aria-expanded", "true");
    expect(triggerButton).toHaveAttribute("aria-controls", menu().id);
    expect(within(menu()).getAllByRole("menuitem").map((entry) => entry.textContent))
      .toEqual(["Rename", "Share", "Move", "Delete"]);
    expect(item("Share")).toBeDisabled();
  });

  it("moves focus onto the first action when it opens", async () => {
    const user = userEvent.setup();
    const { triggerButton } = actionMenu();
    await user.click(triggerButton);
    expect(item("Rename")).toHaveFocus();
  });

  it("walks the enabled actions with the arrow keys, skipping disabled ones, wrapping, and jumps with Home/End", async () => {
    const user = userEvent.setup();
    const { triggerButton } = actionMenu();
    await user.click(triggerButton);
    await user.keyboard("{ArrowDown}");
    expect(item("Move")).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(item("Delete")).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(item("Rename")).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(item("Delete")).toHaveFocus();
    await user.keyboard("{Home}");
    expect(item("Rename")).toHaveFocus();
    await user.keyboard("{End}");
    expect(item("Delete")).toHaveFocus();
  });

  it("runs the focused action on Enter, closes, and hands focus back to the trigger", async () => {
    const user = userEvent.setup();
    const { onMove, onRename, triggerButton } = actionMenu();
    await user.click(triggerButton);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(triggerButton).toHaveFocus();
  });

  it("closes on Escape and on Tab, returning focus to the trigger and running nothing", async () => {
    const user = userEvent.setup();
    const { onRename, onMove, onDelete, triggerButton } = actionMenu("icon");
    await user.click(triggerButton);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(triggerButton).toHaveFocus();

    await user.click(triggerButton);
    await user.tab();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(triggerButton).toHaveFocus();
    expect(onRename).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("closes on a press outside without moving focus back", async () => {
    const user = userEvent.setup();
    const { triggerButton } = actionMenu();
    await user.click(triggerButton);
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    await user.click(elsewhere);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(elsewhere).toHaveFocus();
  });
});
