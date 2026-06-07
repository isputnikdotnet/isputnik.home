import { Bookmark, DownloadCloud, Heart, ListMusic, Palette, UserRound, UsersRound } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { followRoute } from "../../router";
import { isStandalone } from "../../pwa/platform";

export type LibraryNavKey = "saved" | "bookmarks" | "collections" | "shared" | "downloads" | "theme" | "profile";

interface LibraryNavItem {
  key: LibraryNavKey;
  label: string;
  href: string;
  icon: LucideIcon;
}

// Shared toolbar across the personal library pages (Favorites, Bookmarks,
// Collections, Shared with me, Downloads) so the user can hop between them
// without going back to the sidebar menu. Downloads only exists in the installed
// app, so it's only shown there.
export function LibraryNavTabs({ active }: { active: LibraryNavKey }) {
  const tabs: LibraryNavItem[] = [
    { key: "saved", label: "Favorites", href: "/audiobooks/saved", icon: Heart },
    { key: "bookmarks", label: "Bookmarks", href: "/audiobooks/bookmarks", icon: Bookmark },
    { key: "collections", label: "Collections", href: "/collections", icon: ListMusic },
    { key: "shared", label: "Shared with me", href: "/audiobooks/shared", icon: UsersRound },
    ...(isStandalone() || active === "downloads"
      ? [{ key: "downloads" as const, label: "Downloads", href: "/audiobooks/downloads", icon: DownloadCloud }]
      : []),
    { key: "theme", label: "Theme", href: "/theme", icon: Palette },
    { key: "profile", label: "Profile", href: "/profile", icon: UserRound }
  ];

  return (
    <nav className="library-nav-tabs" aria-label="Library sections">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        return (
          <a
            key={tab.key}
            className={`library-nav-tab${active === tab.key ? " is-active" : ""}`}
            href={tab.href}
            onClick={(event) => followRoute(event, tab.href)}
          >
            <Icon size={17} aria-hidden="true" />
            <span>{tab.label}</span>
          </a>
        );
      })}
    </nav>
  );
}
