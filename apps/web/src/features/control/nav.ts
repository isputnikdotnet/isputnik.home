import {
  Activity,
  Image,
  LibraryBig,
  PocketKnife,
  LayoutDashboard,
  Settings,
  ShieldCheck,
  UsersRound,
  Wrench,
  type LucideIcon
} from "lucide-react";
import { controlHref, type ControlSection } from "../../router";
// Plain module-level data + lookup functions, not components — they call i18n.t()
// directly rather than the useTranslation() hook (see docs/i18n-plan.md's
// namespace-key typing pitfall #3). `group.key` and `tab.section` are both
// literal string unions, so the template-literal keys below type-check against
// the declared `control:nav.groups.*` / `control:nav.tabs.*` keys (pitfall #4).
import i18n from "../../i18n";

// The shape of the control panel, in one place. The left nav renders the groups
// and their branches, the tab row renders the tabs of the branch you are standing
// in, each page takes its eyebrow from the group (and its branch) and its <h1>
// from the tab label, and the search palette indexes the lot. Adding a control
// page means adding one tab here — there is nowhere else to keep in sync.
//
// Seven groups, and that is the budget. A new page almost always belongs as a tab
// inside an existing group rather than as an eighth: a long left nav is what this
// structure exists to prevent, and the tab row is free to grow where the nav isn't.
//
// ONE row of tabs, and only one. A second row under it was tried, to say that the
// three duplicate pages are three views of a single scan; it was more chrome than
// the relationship was worth, and the page titles carry it anyway. Related pages
// sit side by side as peers and share a `context` instead — and that row shows
// only the branch you are in, so unrelated peers never crowd it. A branch of one
// page shows no row at all.

export type GroupKey = "overview" | "library" | "members" | "security" | "maintenance" | "utilities" | "settings";

/** The branch a group's tabs can hang off in the left nav — a stable id, not the
 *  displayed word, so a language switch never breaks the active-branch match. */
export type ContextKey = "gallery" | "widgets";

export interface ControlTabDef {
  section: ControlSection;
  /** Grouping that earns a branch in the left nav, a word in the eyebrow, and a
   *  tab row of its own peers — never a SECOND row. "Gallery" says what those
   *  pages work on, "Widgets" what the home page shows, without either costing a
   *  level of navigation or listing the other's pages. */
  context?: ContextKey;
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
    // Sign-ins was a tab of its own until it became the Dashboard's opening
    // view: it and the Dashboard's Logins view drew the same chart over the same
    // events, and only one of them could answer "from where, and by whom".
    tabs: [
      { section: "dashboard" },
      { section: "logs" }
    ]
  },
  {
    key: "library",
    icon: LibraryBig,
    tabs: [
      { section: "libraries" },
      { section: "storage" },
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
    tabs: [
      { section: "security" },
      { section: "securityPolicies" },
      { section: "securityTrusted" },
      { section: "securityBlocked" }
    ]
  },
  {
    key: "maintenance",
    icon: Wrench,
    tabs: [
      { section: "backup" },
      { section: "scheduledJobs" },
      { section: "recycleBin" }
    ]
  },
  {
    key: "utilities",
    icon: PocketKnife,
    // Two peers. There were three duplicate pages here — cleanup, photos, folders —
    // which were three views of one install-wide scan: opening any of them rebuilt it
    // and renumbered everything underneath whoever else was looking. Duplicate cleanup
    // holds its own snapshot and does everything they did, so they are gone.
    tabs: [
      { section: "duplicateCleanup", context: "gallery" },
      { section: "missingPhotos", context: "gallery" },
      // What the home page shows the family, rather than what a library holds.
      { section: "quotes", context: "widgets" }
    ]
  },
  {
    key: "settings",
    icon: Settings,
    tabs: [
      { section: "appearance" },
      { section: "email" },
      { section: "notifications" },
      { section: "storySettings" },
      { section: "maps" },
      { section: "readerAccess" },
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

const TAB_BY_SECTION = new Map<ControlSection, ControlTabDef>(
  ALL_TABS.map((tab) => [tab.section, tab] as const)
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

export function contextLabel(context: ContextKey): string {
  return i18n.t(`control:nav.contexts.${context}`);
}

/** The page's own name — its <h1>. The eyebrow above carries the rest of the path. */
export function sectionTitle(section: ControlSection): string {
  return tabLabel(section);
}

/** The branch a page sits in, where its group has any. */
const CONTEXT_BY_SECTION = new Map<ControlSection, ContextKey>(
  ALL_TABS.flatMap((tab) => (tab.context ? [[tab.section, tab.context] as const] : []))
);

export function sectionContext(section: ControlSection): ContextKey | null {
  return CONTEXT_BY_SECTION.get(section) ?? null;
}

/**
 * The tabs the row should show: the ones sharing the active section's branch.
 *
 * A branch is a place of its own, so Gallery's tabs and Widgets' tabs are not
 * peers just because both hang off Utilities — moving between branches is what
 * the left nav is for. A group with no contexts is a single branch, so this
 * returns all of its tabs and nothing changes for it.
 *
 * A branch holding one page returns one tab, and the caller drops the row
 * entirely rather than drawing a row of one.
 */
export function tabsInScope(section: ControlSection): ControlTabDef[] {
  const context = CONTEXT_BY_SECTION.get(section) ?? null;
  return groupForSection(section).tabs.filter((tab) => (tab.context ?? null) === context);
}

/** Where the page sits, as a trail: "Maintenance", or "Utilities › Gallery". */
export function sectionEyebrow(section: ControlSection): string {
  const context = CONTEXT_BY_SECTION.get(section);
  return [groupLabel(groupForSection(section).key), context ? contextLabel(context) : null]
    .filter(Boolean)
    .join(" › ");
}

/** What the left nav shows underneath a group: one child per distinct `context`
 *  among its tabs, in declaration order, each landing on the first tab that
 *  carries it. Derived rather than listed, so a second Gallery tab joins the
 *  existing branch instead of adding a second one with the same name.
 *
 *  A group with no contexts has no children and stays a plain link. */
export interface ControlNavChild {
  context: ContextKey;
  section: ControlSection;
  icon: LucideIcon;
}

/** Icons for the branches. A context without one falls back to its group's. */
const CONTEXT_ICONS: Record<ContextKey, LucideIcon> = { gallery: Image, widgets: LayoutDashboard };

export function navChildrenFor(group: ControlGroupDef): ControlNavChild[] {
  const seen = new Map<ContextKey, ControlSection>();
  for (const tab of group.tabs) {
    if (tab.context && !seen.has(tab.context)) seen.set(tab.context, tab.section);
  }
  return [...seen].map(([context, section]) => ({
    context,
    section,
    icon: CONTEXT_ICONS[context] ?? group.icon
  }));
}

export function sectionHref(section: ControlSection): string {
  return controlHref(section);
}
