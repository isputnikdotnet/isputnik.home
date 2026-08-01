import type { ReactNode } from "react";
import type { ControlSection } from "../../router";
import { sectionEyebrow, sectionTitle } from "./nav";

// The header every control-panel page opens with. The eyebrow is the nav group
// and the title is the tab, both read straight from nav.ts — so a page can
// never disagree with the nav about where it lives, which is how the old panel
// ended up with "Maintenance" pages sitting under "Digital Library".
//
// `children` is the right-hand side of the row: a Refresh button, a search
// field, an "Add library" action.
export function ControlSectionHead({
  section,
  icon,
  iconClassName,
  description,
  className,
  children
}: {
  section: ControlSection;
  /** The 30px lucide icon for the page's tile. Omit for a plain text header. */
  icon?: ReactNode;
  /** Accent modifier on the icon tile, e.g. "blue", "logs", "invites". */
  iconClassName?: string;
  description?: ReactNode;
  /** Extra classes on the head row, for page-specific layout. */
  className?: string;
  children?: ReactNode;
}) {
  const copy = (
    <div className={icon ? "admin-heading-copy" : undefined}>
      <p className="eyebrow">{sectionEyebrow(section)}</p>
      <h1>{sectionTitle(section)}</h1>
      {description && <p className="section-description">{description}</p>}
    </div>
  );

  return (
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
}
