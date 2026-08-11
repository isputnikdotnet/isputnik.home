import { Home } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { MouseEvent } from "react";
import { followRoute } from "../router";

export interface SectionNavItem {
  key: string;
  label: string;
  href: string;
  icon: LucideIcon;
  // A handful of sections (Gallery's Timeline/Albums/…) are views toggled by
  // local state rather than separate routes — same as their existing tab rows,
  // which already preventDefault() and flip state instead of navigating. When
  // omitted, the link just follows `href` like every other section's items do.
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}

// The contextual left nav a media section (Gallery, Ebooks, Audiobooks, Family
// Tree, …) swaps in for the generic main nav — same shape as the control panel's
// and the user area's own sidebars: a way back to Home, then the section's own
// destinations. Settings/Profile/Logout live in DashboardShell's standard footer
// beneath every nav, so this only ever carries what's specific to the section.
export function SectionNav({
  ariaLabel,
  groupLabel,
  items,
  activeKey
}: {
  ariaLabel: string;
  groupLabel: string;
  items: SectionNavItem[];
  activeKey: string;
}) {
  return (
    <nav className="home-control-nav" aria-label={ariaLabel}>
      <a className="home-nav-link control-nav-exit" href="/" onClick={(event) => followRoute(event, "/")}>
        <Home size={21} aria-hidden="true" />
        <span>Home</span>
      </a>

      <div className="home-control-group">
        <p>{groupLabel}</p>
        {items.map((item) => (
          <SectionNavLink key={item.key} item={item} active={item.key === activeKey} />
        ))}
      </div>
    </nav>
  );
}

function SectionNavLink({ item, active }: { item: SectionNavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <a
      className={`home-nav-link${active ? " is-active" : ""}`}
      href={item.href}
      aria-current={active ? "page" : undefined}
      onClick={(event) => (item.onClick ? item.onClick(event) : followRoute(event, item.href))}
    >
      <Icon size={21} aria-hidden="true" />
      <span>{item.label}</span>
    </a>
  );
}
