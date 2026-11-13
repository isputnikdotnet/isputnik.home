import { Fragment, type MouseEvent as ReactMouseEvent } from "react";
import type { TFunction } from "i18next";
import { Bug, HelpCircle, Info, Lightbulb, MessagesSquare } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { followRoute } from "../router";
import { APP_VERSION } from "../shared/appVersion";
import { bugReportUrl, FEATURE_REQUEST_URL, REPO_DISCUSSIONS_URL } from "../shared/links";

// Help & feedback: one list, drawn by the ? beside the person's name in the top
// layout, by the sidebar's Help item in the classic one, and by the phone's menu
// sheet — so the three can never disagree about what is in it.
//
// Three groups: getting help, giving feedback, and the app itself. The community
// and feedback links lead to GitHub, so only administrators see them: for a
// relative, "Report a bug" ending at a GitHub sign-up is a dead end, and the person
// who runs the server is who they should tell. Nothing about the server or the
// person goes into these links; the bug form gets the version, nothing else.

export type HelpGroup = "help" | "feedback" | "about";

export interface HelpMenuLink {
  key: string;
  href: string;
  icon: LucideIcon;
  label: string;
  group: HelpGroup;
  external?: boolean;
  /** The page it is, for marking it active ("about", "help"). */
  activeKey?: string;
}

export function helpMenuLinks(t: TFunction, isAdmin: boolean): HelpMenuLink[] {
  return [
    { key: "guides", href: "/help", icon: HelpCircle, label: t("nav.helpGuides"), group: "help", activeKey: "help" },
    ...(isAdmin
      ? [
          { key: "community", href: REPO_DISCUSSIONS_URL, icon: MessagesSquare, label: t("nav.community"), group: "help" as const, external: true },
          { key: "bug", href: bugReportUrl(APP_VERSION), icon: Bug, label: t("nav.reportBug"), group: "feedback" as const, external: true },
          { key: "feature", href: FEATURE_REQUEST_URL, icon: Lightbulb, label: t("nav.requestFeature"), group: "feedback" as const, external: true }
        ]
      : []),
    { key: "about", href: "/about", icon: Info, label: t("nav.aboutApp"), group: "about", activeKey: "about" }
  ];
}

/** The links as menu items, a thin rule between groups. `onPick` closes the menu. */
export function HelpMenuItems({ links, active, onPick }: { links: HelpMenuLink[]; active?: string; onPick: () => void }) {
  return (
    <>
      {links.map((item, index) => {
        const Icon = item.icon;
        const newGroup = index > 0 && links[index - 1].group !== item.group;
        const isActive = item.activeKey !== undefined && item.activeKey === active;
        return (
          <Fragment key={item.key}>
            {newGroup && <span className="help-menu-separator" role="separator" />}
            <a
              className={`home-user-menu-link${isActive ? " is-active" : ""}`}
              href={item.href}
              role="menuitem"
              {...(item.external
                ? { target: "_blank", rel: "noreferrer", onClick: onPick }
                : { onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => { onPick(); followRoute(event, item.href); } })}
            >
              <Icon size={19} aria-hidden="true" />
              <span>{item.label}</span>
            </a>
          </Fragment>
        );
      })}
    </>
  );
}
