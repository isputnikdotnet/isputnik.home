import type React from "react";

// Arrow keys walk a tab row, as they do in every other tablist a screen reader
// user meets. Focus only — activation stays with Enter/Space (a click), so a tab
// whose panel loads data doesn't fetch on every key press on the way past. Works
// for button tabs (shared/Button's `tab` variant, TabStrip) and link tabs
// (shared/RouteTab) alike.
export function moveAlongTablist(event: React.KeyboardEvent<HTMLElement>) {
  const list = event.currentTarget.closest('[role="tablist"]');
  if (!list) return;
  const tabs = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]')).filter(
    (tab) =>
      !(tab instanceof HTMLButtonElement && tab.disabled) &&
      tab.getAttribute("aria-disabled") !== "true" &&
      tab.closest('[role="tablist"]') === list
  );
  const index = tabs.indexOf(event.currentTarget);
  if (index < 0 || tabs.length < 2) return;
  const target =
    event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length]
    : event.key === "ArrowLeft" ? tabs[(index - 1 + tabs.length) % tabs.length]
    : event.key === "Home" ? tabs[0]
    : event.key === "End" ? tabs[tabs.length - 1]
    : null;
  if (!target) return;
  event.preventDefault();
  target.focus();
}
