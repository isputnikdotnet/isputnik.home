import { createContext, useContext } from "react";
import type React from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { controlHref, followBack, followRoute, type ControlSection } from "../../router";
import { appLabel, areaLabel, groupLabel, placeOf, rowLabel, tabLabel, tabRowFor } from "./nav";

// The line above every control-panel page's title (but the Dashboard's): the way
// back, and where the page sits — "← Back │ Applications › Gallery › Overview".
// Back steps back through history (or, opened from a link, to the nearest level
// up); each name after it opens that level's own page: the group's first page,
// the workspace's Overview, the tab a page sits under, or the list a detail page
// was opened from. Back is always there and always says Back, wherever you came
// from, so the line reads the same on every visit.
// It takes the eyebrow's place, so going back costs no line of its own.

interface Crumb { href: string; label: string }

/** The top of the control panel's work area, above a workspace's tab row and status
 *  line: where every page's back line is drawn, wherever the page declares it.
 *  Null outside the panel (a section rendered on its own), which draws it in place. */
export const BackBarSlot = createContext<HTMLElement | null>(null);

const pathOf = (href: string) => new URL(href, window.location.origin).pathname.replace(/\/+$/, "");
const sameAddress = (a: string, b: string) => {
  const left = new URL(a, window.location.origin);
  const right = new URL(b, window.location.origin);
  return pathOf(left.href) === pathOf(right.href) && left.search === right.search;
};

/** The levels above a section: its group, its workspace, the tab it is a page of. */
function crumbsOf(section: ControlSection, from: string | null, includeSelf: boolean): Crumb[] {
  const place = placeOf(section, from);
  const levels: { section: ControlSection; label: string }[] = [];
  if (place.group) levels.push({ section: place.group.tabs[0].section, label: groupLabel(place.group.key) });
  if (place.app) levels.push({ section: place.app.tabs[0].section, label: appLabel(place.app.key) });
  // A section of Security & Members, or the Dashboard over its own tabs.
  if (place.area) levels.push({ section: place.area.tabs[0].section, label: areaLabel(place.area.key) });
  if (place.parent && place.parent !== "applications") {
    const parentDef = tabRowFor(place).find((tab) => tab.section === place.parent);
    levels.push({ section: place.parent, label: parentDef ? rowLabel(parentDef) : tabLabel(place.parent) });
  }
  const crumbs: Crumb[] = [];
  for (const level of levels) {
    if (!includeSelf && level.section === section) continue;
    const href = controlHref(level.section);
    // Two levels may open the same page (Videos and its Overview, Infrastructure and
    // Services): both names stay, so the line reads the whole way down. Only the
    // same name twice is said once.
    if (crumbs.length > 0 && crumbs[crumbs.length - 1].label === level.label) continue;
    crumbs.push({ href, label: level.label });
  }
  return crumbs;
}

export function ControlBackBar({ section, from = null, list, fallback, onBack }: {
  section: ControlSection;
  /** ?from= of a shared page, which follows the workspace it was opened from. */
  from?: string | null;
  /** A detail page's list (a member's Members, a phone's Device Sync): the last level. */
  list?: Crumb;
  /** Where Back goes without history; the last level when omitted. */
  fallback?: string;
  /** Back handled by the page (an in-page detail that steps back itself). */
  onBack?: () => void;
}) {
  const { t } = useTranslation(["control"]);
  const slot = useContext(BackBarSlot);
  const crumbs = crumbsOf(section, from, Boolean(list));
  if (list) {
    if (crumbs.length > 0 && sameAddress(crumbs[crumbs.length - 1].href, list.href)) crumbs.pop();
    crumbs.push(list);
  }
  const last = crumbs[crumbs.length - 1] ?? null;
  const backTo = fallback ?? last?.href ?? controlHref("dashboard");

  const back = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!onBack) return followBack(event, backTo);
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onBack();
  };

  const bar = (
    <nav className="control-backbar" aria-label={t("control:ui.whereAria")}>
      <a className="control-backbar-back" href={backTo} onClick={back}>
        <ArrowLeft size={15} aria-hidden="true" />
        {t("control:ui.back")}
      </a>
      {crumbs.length > 0 && (
        <ol className="control-backbar-crumbs">
          {crumbs.map((crumb, index) => (
            <li key={`${index}:${crumb.href}`}>
              {index > 0 && <ChevronRight size={13} aria-hidden="true" />}
              <a href={crumb.href} onClick={(event) => followRoute(event, crumb.href)}>{crumb.label}</a>
            </li>
          ))}
        </ol>
      )}
    </nav>
  );
  // The same place on every page: the very top, above a workspace's tab row.
  return slot ? createPortal(bar, slot) : bar;
}
