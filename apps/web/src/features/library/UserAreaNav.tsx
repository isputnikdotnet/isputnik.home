import {
  BookText,
  Bookmark,
  DownloadCloud,
  Heart,
  Home,
  ListMusic,
  Quote,
  UsersRound
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isStandalone } from "../../pwa/platform";
import { followRoute } from "../../router";

export type UserAreaSection =
  | "profile"
  | "likes"
  | "bookmarks"
  | "quotes"
  | "stories"
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
  const { t } = useTranslation();
  const libraryLinks: UserNavItem[] = [
    { section: "likes", label: t("nav.likes"), href: "/likes", icon: Heart },
    { section: "bookmarks", label: t("nav.bookmarks"), href: "/bookmarks", icon: Bookmark },
    { section: "quotes", label: t("nav.quotes"), href: "/quotes", icon: Quote },
    { section: "stories", label: t("nav.stories"), href: "/stories", icon: BookText },
    { section: "collections", label: t("nav.collections"), href: "/collections", icon: ListMusic },
    { section: "shared", label: t("nav.sharedWithMe"), href: "/shared", icon: UsersRound },
    ...(isStandalone() || active === "downloads"
      ? [{ section: "downloads" as const, label: t("nav.downloads"), href: "/downloads", icon: DownloadCloud }]
      : [])
  ];

  return (
    <nav className="home-control-nav" aria-label={t("nav.aria.userPages")}>
      <UserNavLink icon={Home} label={t("nav.home")} href="/" active={false} />

      <div className="home-control-group">
        <p>{t("nav.myLibrary")}</p>
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
