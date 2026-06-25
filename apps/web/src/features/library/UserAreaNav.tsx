import {
  Bookmark,
  DownloadCloud,
  Heart,
  Home,
  ListMusic,
  UserRound,
  UsersRound
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { isStandalone } from "../../pwa/platform";
import { followRoute } from "../../router";

export type UserAreaSection =
  | "profile"
  | "favorites"
  | "bookmarks"
  | "collections"
  | "shared"
  | "downloads";

interface UserNavItem {
  section: UserAreaSection;
  label: string;
  href: string;
  icon: LucideIcon;
}

export function UserAreaNav({ active }: { active: UserAreaSection }) {
  const libraryLinks: UserNavItem[] = [
    { section: "favorites", label: "Favorites", href: "/favorites", icon: Heart },
    { section: "bookmarks", label: "Bookmarks", href: "/bookmarks", icon: Bookmark },
    { section: "collections", label: "Collections", href: "/collections", icon: ListMusic },
    { section: "shared", label: "Shared with me", href: "/shared", icon: UsersRound },
    ...(isStandalone() || active === "downloads"
      ? [{ section: "downloads" as const, label: "Downloads", href: "/downloads", icon: DownloadCloud }]
      : [])
  ];

  return (
    <nav className="home-control-nav" aria-label="User pages">
      <UserNavLink icon={Home} label="Home" href="/" active={false} />

      <div className="home-control-group">
        <p>Account</p>
        <UserNavLink icon={UserRound} label="Profile" href="/profile" active={active === "profile"} />
      </div>

      <div className="home-control-group">
        <p>My Library</p>
        {libraryLinks.map((item) => (
          <UserNavLink
            key={item.section}
            icon={item.icon}
            label={item.label}
            href={item.href}
            active={active === item.section}
          />
        ))}
      </div>

    </nav>
  );
}

function UserNavLink({
  icon: Icon,
  label,
  href,
  active
}: {
  icon: LucideIcon;
  label: string;
  href: string;
  active: boolean;
}) {
  return (
    <a
      className={`home-nav-link${active ? " is-active" : ""}`}
      href={href}
      onClick={(event) => followRoute(event, href)}
    >
      <Icon size={21} aria-hidden="true" />
      <span>{label}</span>
    </a>
  );
}
