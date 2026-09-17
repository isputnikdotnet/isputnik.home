import { useEffect } from "react";

// How long to wait for the target to exist. A section's chunk loads lazily and
// most pages fetch before they draw their cards, so the element named by the hash
// is rarely there when the route changes.
const WAIT_MS = 6000;
const FLASH_MS = 1800;

/**
 * Brings the element named by the URL's #hash into view once it renders — what
 * lets a search hit for "Password policy" land on that card rather than at the
 * top of Policies. Browsers only do this themselves for a full page load with
 * the element already in the document; neither is true for an in-app jump.
 *
 * Runs when the section changes and on every popstate, so a jump to another card
 * of the page you are already on works too.
 */
export function useAnchorScroll(section: string) {
  useEffect(() => {
    let observer: MutationObserver | null = null;
    let timeout = 0;

    const stop = () => {
      observer?.disconnect();
      observer = null;
      window.clearTimeout(timeout);
    };

    const reveal = (target: HTMLElement) => {
      stop();
      // A beat later, so the search palette closing has handed focus back first
      // (it would otherwise take it from the card), and instant rather than
      // smooth: the page is often still settling, and a smooth scroll aimed at
      // where the card was ends short of where it is.
      timeout = window.setTimeout(() => land(target), 60);
    };

    const land = (target: HTMLElement) => {
      target.scrollIntoView({ block: "start" });
      // Focus for keyboard and screen-reader users, without a second scroll.
      if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
      target.classList.add("control-anchor-flash");
      window.setTimeout(() => target.classList.remove("control-anchor-flash"), FLASH_MS);
    };

    const seek = () => {
      stop();
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id) return;
      const find = () => document.getElementById(id);
      const found = find();
      if (found) {
        reveal(found);
        return;
      }
      observer = new MutationObserver(() => {
        const target = find();
        if (target) reveal(target);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      timeout = window.setTimeout(stop, WAIT_MS);
    };

    seek();
    window.addEventListener("popstate", seek);
    return () => {
      stop();
      window.removeEventListener("popstate", seek);
    };
  }, [section]);
}
