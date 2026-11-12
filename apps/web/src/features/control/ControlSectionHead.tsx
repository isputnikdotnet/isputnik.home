import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { controlHref, type ControlSection } from "../../router";
import { currentFrom, placeOf, sectionEyebrow, sectionTitle } from "./nav";
import { PageBack } from "../../shared/useQueryPage";

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
  /** History-aware Back, with a natural parent for direct links. */
  back?: { href: string; label: ReactNode };
  /** Extra classes on the head row, for page-specific layout. */
  className?: string;
  children?: ReactNode;
}) {
  // A shared page (Book categories, Tags) follows the workspace it was opened from.
  const from = currentFrom();
  const { t } = useTranslation(["control"]);
  const place = placeOf(section, from);
  const parent = place.parent ?? (place.app ? "applications" : place.group?.tabs[0].section);
  const copy = (
    <div className={icon ? "admin-heading-copy" : undefined}>
      <p className="eyebrow">{sectionEyebrow(section, from)}</p>
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

  if (back) return <><PageBack {...back} />{head}</>;
  if (section === "dashboard") return head;
  const parentHref = controlHref(parent && parent !== section ? parent : "dashboard");
  return (
    <>
      <PageBack href={parentHref} label={t("control:ui.back")} />
      {head}
    </>
  );
}
