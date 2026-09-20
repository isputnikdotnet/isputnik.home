import {
  Activity,
  LibraryBig,
  Settings,
  ShieldCheck,
  UsersRound,
  Wrench,
  type LucideIcon } from "lucide-react";
import { controlHref, type ControlSection } from "../../router";
// Plain module-level data + lookup functions, not components — they call i18n.t()
// directly rather than the useTranslation() hook (see docs/i18n-plan.md's
// namespace-key typing pitfall #3). `group.key` and `tab.section` are both
// literal string unions, so the template-literal keys below type-check against
// the declared `control:nav.groups.*` / `control:nav.tabs.*` keys (pitfall #4).
import i18n from "../../i18n";

// The shape of the control panel, in one place. The left nav renders the groups,
// the tab row renders the tabs of the group you are standing in, each page takes
// its eyebrow from the group and its <h1> from the tab label, and the search
// palette indexes the lot. Adding a control page means adding one tab here —
// there is nowhere else to keep in sync.
//
// Six groups, and that is the budget. A new page almost always belongs as a tab
// inside an existing group rather than as a seventh: a long left nav is what this
// structure exists to prevent, and the tab row is free to grow where the nav isn't.
//
// Every group is the same thing — a link to its first tab, over one row of its
// tabs — and nothing else. Two exceptions were tried and retired in 4.15
// (docs/control-panel-navigation-review.md):
//
//   * Utilities folded out into "Gallery" and "Widgets" branches, each with a tab
//     row of its own. It was the one group you had to learn; its pages were a
//     cleanup job and a widget's content, which are Maintenance and Settings.
//   * Maps was a group of one page (4.4–4.14): four cards with a switch on each.
//     A page of switches is what Settings is, and a group of one draws no tab row,
//     so it read differently from every other group.
//
// ONE row of tabs, and only one. A second row under it was tried twice — for the
// duplicate pages, and as the Dashboard's six views — and both times it was more
// chrome than the relationship was worth. A page whose content wants to be split
// is split into tabs; a view switch inside a page is for views of one task.

export type GroupKey = "overview" | "library" | "members" | "security" | "maintenance" | "settings";

export interface ControlTabDef {
  section: ControlSection;
}

export interface ControlGroupDef {
  key: GroupKey;
  icon: LucideIcon;
  tabs: ControlTabDef[];
}

export const CONTROL_GROUPS: ControlGroupDef[] = [
  {
    key: "overview",
    icon: Activity,
    // What state the server is in and what has been happening. The Dashboard is
    // the health page; the analysis that used to hang off it as views is here as
    // tabs, or went to the group whose question it answers (sign-ins to Security,
    // tasks to Maintenance).
    tabs: [
      { section: "dashboard" },
      { section: "activity" },
      { section: "libraryStats" },
      { section: "logs" }
    ]
  },
  {
    key: "library",
    icon: LibraryBig,
    tabs: [
      { section: "libraries" },
      { section: "storage" },
      { section: "storageContents" },
      { section: "categories" },
      { section: "tags" }
    ]
  },
  {
    key: "members",
    icon: UsersRound,
    tabs: [
      { section: "users" },
      { section: "groups" },
      { section: "invites" }
    ]
  },
  {
    key: "security",
    icon: ShieldCheck,
    // Investigate access, then configure protection: who got in and from where
    // sit beside the policies and lists that decide who may.
    tabs: [
      { section: "security" },
      { section: "signIns" },
      { section: "signInLocations" },
      { section: "securityPolicies" },
      { section: "securityTrusted" },
      { section: "securityBlocked" }
    ]
  },
  {
    key: "maintenance",
    icon: Wrench,
    // Follow work, recover data, clean up. Tasks leads: it is where a scan, a
    // backup or a cleanup job is followed, whichever page started it.
    tabs: [
      { section: "tasks" },
      { section: "scheduledJobs" },
      { section: "backup" },
      { section: "recycleBin" },
      { section: "duplicateCleanup" },
      { section: "missingPhotos" },
      { section: "videoStreaming" }
    ]
  },
  {
    key: "settings",
    icon: Settings,
    // How the app looks and what it can do. Quotes is the home widget's content,
    // Maps a page of feature switches. Reader access left for Profile in 4.15:
    // the tokens are the signed-in person's own, not the server's.
    tabs: [
      { section: "appearance" },
      { section: "quotes" },
      { section: "mapSetup" },
      { section: "storySettings" },
      { section: "email" },
      { section: "notifications" },
      { section: "about" }
    ]
  }
];

/** Every tab there is. One row per group, so this is simply all of them — what
 *  search indexes and what page titles come from. */
export const ALL_TABS: ControlTabDef[] = CONTROL_GROUPS.flatMap((group) => group.tabs);

const GROUP_BY_SECTION = new Map<ControlSection, ControlGroupDef>(
  CONTROL_GROUPS.flatMap((group) => group.tabs.map((tab) => [tab.section, group] as const))
);

export function groupForSection(section: ControlSection): ControlGroupDef {
  // Every section is on exactly one tab, so the lookup can't miss; Overview is
  // the safe landing spot if a future section is ever added without a tab.
  return GROUP_BY_SECTION.get(section) ?? CONTROL_GROUPS[0];
}

/** The displayed word for a nav group. Called at render/build time (never cached
 *  at module scope) so it stays reactive to a language switch. */
export function groupLabel(key: GroupKey): string {
  return i18n.t(`control:nav.groups.${key}`);
}

/** The displayed word for a tab — also the page's own <h1>. */
export function tabLabel(section: ControlSection): string {
  return i18n.t(`control:nav.tabs.${section}`);
}

/** The page's own name — its <h1>. The eyebrow above carries the rest of the path. */
export function sectionTitle(section: ControlSection): string {
  return tabLabel(section);
}

/** Where the page sits: its group's name. */
export function sectionEyebrow(section: ControlSection): string {
  return groupLabel(groupForSection(section).key);
}

export function sectionHref(section: ControlSection): string {
  return controlHref(section);
}
