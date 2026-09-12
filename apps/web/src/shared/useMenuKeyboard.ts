import { useEffect, type KeyboardEvent, type RefObject } from "react";

// The keyboard half of a menu button (WAI-ARIA APG "menu button"), for a menu
// whose open/close state lives elsewhere — useAnchoredMenu's, for one.
//
// On open, focus moves INTO the menu: to the checked item when there is one (a
// sort menu opens on the order you are in), else the first. Up/Down walk the
// items and wrap, Home/End jump to the ends. Escape and Tab close the menu and
// put focus back on the trigger — so does choosing an item, through
// `closeAndRestore` — because a menu portalled to <body> has nowhere sensible
// for focus to fall when it unmounts. A press outside closes it without moving
// focus: the reader has already put it where they meant to.
//
// The same walk serves a listbox popup (SelectMenu, a form's single choice): its
// options are role="option" and the chosen one is aria-selected rather than
// aria-checked, but the keys and the way back to the trigger are identical.
const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"]';
const CURRENT_SELECTOR = '[aria-checked="true"], [aria-selected="true"]';

function itemsIn(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return [];
  return Array.from(menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter(
    (item) => !(item as HTMLButtonElement).disabled && item.getAttribute("aria-disabled") !== "true"
  );
}

export function useMenuKeyboard({
  open,
  close,
  menuRef,
  triggerRef
}: {
  open: boolean;
  close: () => void;
  menuRef: RefObject<HTMLElement | null>;
  triggerRef: RefObject<HTMLElement | null>;
}) {
  useEffect(() => {
    if (!open) return;
    const items = itemsIn(menuRef.current);
    const start = items.find((item) => item.matches(CURRENT_SELECTOR)) ?? items[0];
    // preventScroll: the menu is fixed-positioned, and a scroll is one of the
    // things that closes it.
    start?.focus({ preventScroll: true });
  }, [open, menuRef]);

  const closeAndRestore = () => {
    close();
    triggerRef.current?.focus({ preventScroll: true });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const items = itemsIn(menuRef.current);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focus = (item: HTMLElement | undefined) => {
      event.preventDefault();
      item?.focus({ preventScroll: true });
    };
    switch (event.key) {
      case "ArrowDown":
        focus(items[(index + 1) % items.length]);
        break;
      case "ArrowUp":
        focus(items[index <= 0 ? items.length - 1 : index - 1]);
        break;
      case "Home":
        focus(items[0]);
        break;
      case "End":
        focus(items[items.length - 1]);
        break;
      case "Escape":
      case "Tab":
        // preventDefault on Escape also tells a surrounding Modal it was handled.
        event.preventDefault();
        closeAndRestore();
        break;
    }
  };

  return { onKeyDown, closeAndRestore };
}
