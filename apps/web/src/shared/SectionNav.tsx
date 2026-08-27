import { useTranslation } from "react-i18next";
import { Home } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { followRoute } from "../router";

// Every item is a link to a real address, with no escape hatch for one that
// isn't. Gallery's views were local state and were listed here behind an
// onClick that swallowed the click; a nav that looks like links but isn't
// breaks new-tab, middle-click and the browser's Back button, so the views
// became routes (GALLERY_VIEW_PATHS) instead of the nav learning to lie.
export interface SectionNavItem {
  key: string;
  label: string;
  href: string;
  icon: LucideIcon;
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
  const { t } = useTranslation();
  return (
    <nav className="home-control-nav" aria-label={ariaLabel}>
      <a className="home-nav-link control-nav-exit" href="/" onClick={(event) => followRoute(event, "/")}>
        <Home size={21} aria-hidden="true" />
        <span>{t("nav.home")}</span>
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
      onClick={(event) => followRoute(event, item.href)}
    >
      <Icon size={21} aria-hidden="true" />
      <span>{item.label}</span>
    </a>
  );
}
