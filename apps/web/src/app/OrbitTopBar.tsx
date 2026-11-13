import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, HelpCircle, LogOut, Settings, UserRound } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { followRoute } from "../router";
import { Button } from "../shared/Button";
import { HelpMenuItems, type HelpMenuLink } from "./helpMenu";

export interface OrbitNavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  active: boolean;
}

export interface OrbitMenuLink {
  label: string;
  href: string;
  icon: LucideIcon;
  external?: boolean;
}

// The top layout's bar (app/layoutChoice.ts): the brand, the sections, then the
// control panel, help & feedback (the ?) and the person. It stands in for the sidebar above the phone
// breakpoint; phones keep their four-tab bar.
export function OrbitTopBar({
  items,
  media,
  controlHref,
  displayName,
  unseen,
  menuLinks,
  helpLinks,
  active,
  onLogout
}: {
  items: OrbitNavItem[];
  /** The Media button, which sits right after the first item (Home). */
  media: ReactNode;
  controlHref: string | null;
  displayName: string;
  unseen: number;
  menuLinks: OrbitMenuLink[];
  /** Help & feedback, beside the name (app/helpMenu.tsx). */
  helpLinks: HelpMenuLink[];
  /** The page shown, to mark Help guides or About as the one you are on. */
  active?: string;
  onLogout: () => void;
}) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const helpRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!helpOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!helpRef.current?.contains(event.target as Node)) setHelpOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHelpOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [helpOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <header className="orbit-topbar">
      <a className="orbit-brand" href="/" onClick={(event) => followRoute(event, "/")} aria-label={t("nav.aria.brandHome")}>
        <img src="/Assets/brand/isputnik-app-icon.svg" alt="" width={30} height={30} />
        <strong>iSputnik</strong>
      </a>

      <nav className="orbit-nav" aria-label={t("nav.aria.primary")}>
        {items.map((item, index) => {
          const Icon = item.icon;
          return (
            <Fragment key={item.href}>
              <a
                className={`orbit-nav-link${item.active ? " is-active" : ""}`}
                href={item.href}
                aria-current={item.active ? "page" : undefined}
                onClick={(event) => followRoute(event, item.href)}
              >
                <Icon size={18} aria-hidden="true" />
                <span>{item.label}</span>
              </a>
              {index === 0 && media}
            </Fragment>
          );
        })}
      </nav>

      <div className="orbit-topbar-end">
        {controlHref && (
          <a
            className="orbit-control-link"
            href={controlHref}
            title={t("nav.controlPanel")}
            aria-label={t("nav.controlPanel")}
            onClick={(event) => followRoute(event, controlHref)}
          >
            <Settings size={19} aria-hidden="true" />
            <span>{t("nav.controlPanel")}</span>
          </a>
        )}

        <div className="orbit-user orbit-help" ref={helpRef}>
          <Button
            variant="icon"
            className={`orbit-help-button${helpOpen || active === "help" || active === "about" ? " is-active" : ""}`}
            onClick={() => { setMenuOpen(false); setHelpOpen((open) => !open); }}
            aria-haspopup="menu"
            aria-expanded={helpOpen}
            aria-label={t("nav.helpMenu")}
            title={t("nav.helpMenu")}
          >
            <HelpCircle size={20} aria-hidden="true" />
          </Button>
          {helpOpen && (
            <div className="orbit-user-menu" role="menu" aria-label={t("nav.helpMenu")}>
              <HelpMenuItems links={helpLinks} active={active} onPick={() => setHelpOpen(false)} />
            </div>
          )}
        </div>

        <div className="orbit-user" ref={menuRef}>
          <Button
            variant="bare"
            className="orbit-user-button"
            onClick={() => { setHelpOpen(false); setMenuOpen((open) => !open); }}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <span className="orbit-user-icon" aria-hidden="true">
              <UserRound size={18} />
              {unseen > 0 && <span className="nav-dot" />}
            </span>
            <span className="orbit-user-name">{displayName}</span>
            <ChevronDown size={16} aria-hidden="true" />
          </Button>

          {menuOpen && (
            <div className="orbit-user-menu" role="menu" aria-label={t("nav.aria.profileMenu")}>
              {menuLinks.map((item) => {
                const Icon = item.icon;
                return (
                  <a
                    key={item.href}
                    className="home-user-menu-link"
                    href={item.href}
                    role="menuitem"
                    {...(item.external
                      ? { target: "_blank", rel: "noreferrer", onClick: () => setMenuOpen(false) }
                      : { onClick: (event: React.MouseEvent<HTMLAnchorElement>) => { setMenuOpen(false); followRoute(event, item.href); } })}
                  >
                    <Icon size={19} aria-hidden="true" />
                    <span>{item.label}</span>
                  </a>
                );
              })}
              <Button
                variant="bare"
                className="home-user-menu-link home-logout-link"
                role="menuitem"
                onClick={() => { setMenuOpen(false); onLogout(); }}
              >
                <LogOut size={19} aria-hidden="true" />
                <span>{t("nav.logout")}</span>
              </Button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
