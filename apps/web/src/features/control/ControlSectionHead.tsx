import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { type ControlSection } from "../../router";
import { ControlBackBar } from "./ControlBackBar";
import { currentFrom, sectionEyebrow, sectionTitle } from "./nav";

// The header every control-panel page opens with. The eyebrow is the nav group
// and the title is the tab, both read straight from nav.ts — so a page can
// never disagree with the nav about where it lives, which is how the old panel
// ended up with "Maintenance" pages sitting under "Digital Library".
//
// A page under a tab (Duplicate cleanup under Gallery › Organize) also opens with a link back to that
// tab, and its eyebrow names it: the tab row above stays on the tab, so this is
// where the page says it is one step down.
//
// `children` is the right-hand side of the row: a Refresh button, a search
// field, an "Add library" action.
export function ControlSectionHead({
  section,
  icon,
  iconClassName,
  description,
  title,
  back,
  className,
  children
}: {
  section: ControlSection;
  /** The 30px lucide icon for the page's tile. Omit for a plain text header. */
  icon?: ReactNode;
  /** Accent modifier on the icon tile, e.g. "blue", "logs", "invites". */
  iconClassName?: string;
  description?: ReactNode;
  /** Detail pages keep the section's identity with their own title. */
  title?: ReactNode;
  /** A detail page's list (its label names it: "Diagnostics"), or, labelled just
   *  "Back", where Back goes without history. */
  back?: { href: string; label: string };
  /** Extra classes on the head row, for page-specific layout. */
  className?: string;
  children?: ReactNode;
}) {
  // A shared page (Book categories, Tags) follows the workspace it was opened from.
  const from = currentFrom();
  const { t } = useTranslation(["control"]);
  // Where Back goes and what the last level is. A page of the same address (a
  // job opened from Scheduled jobs, ?show=…) is one level under that section's
  // own page; a named list is that list; a bare "Back" only says where to go.
  const list = (() => {
    if (!back) return undefined;
    const target = new URL(back.href, window.location.origin);
    if (target.pathname === window.location.pathname) return { href: back.href, label: sectionTitle(section) };
    return back.label === t("control:ui.back") ? undefined : { href: back.href, label: back.label };
  })();
  const copy = (
    <div className={icon ? "admin-heading-copy" : undefined}>
      {section === "dashboard" && <p className="eyebrow">{sectionEyebrow(section, from)}</p>}
      <h1>{title ?? sectionTitle(section)}</h1>
      {description && <p className="section-description">{description}</p>}
    </div>
  );

  const head = (
    <div className={["section-head", icon ? "admin-section-head" : "", className].filter(Boolean).join(" ")}>
      {icon ? (
        <div className="admin-title-wrap">
          <span className={["admin-page-icon", iconClassName].filter(Boolean).join(" ")} aria-hidden="true">
            {icon}
          </span>
          {copy}
        </div>
      ) : (
        copy
      )}
      {children}
    </div>
  );

  if (section === "dashboard") return head;
  // Above the whole head, starting where the icon does: the way back first.
  // One block, so a page that spaces its children (a grid with a gap) spaces the
  // bar and its head as one: the bar is the same distance above the title everywhere.
  return (
    <div className="control-page-top">
      <ControlBackBar section={section} from={from} list={list} fallback={back?.href} />
      {head}
    </div>
  );
}
