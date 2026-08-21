import {
  Activity,
  Image,
  LibraryBig,
  PocketKnife,
  Settings,
  ShieldCheck,
  UsersRound,
  Wrench,
  type LucideIcon
} from "lucide-react";
import { controlHref, type ControlSection } from "../../router";

// The shape of the control panel, in one place. The left nav renders the groups,
// the tab row renders the active group's tabs, each page takes its eyebrow from
// the group and its <h1> from the tab label, and the search palette indexes the
// lot. Adding a control page means adding one tab here — there is nowhere else to
// keep in sync.
//
// Seven groups, and that is the budget. A new page almost always belongs as a tab
// inside an existing group rather than as an eighth: a long left nav is what this
// structure exists to prevent, and the tab row is free to grow where the nav isn't.
//
// ONE row of tabs, and only one. A second row under it was tried, to say that the
// three duplicate pages are three views of a single scan; it was more chrome than
// the relationship was worth, and the page titles carry it anyway. Related pages
// sit side by side as peers and share a `context` instead.

export interface ControlTabDef {
  section: ControlSection;
  label: string;
  /** Grouping that earns a branch in the left nav and a word in the eyebrow, but
   *  not a row of its own: one media type has utilities so far, so "Gallery" says
   *  what these work on without costing a level of navigation. */
  context?: string;
}

export interface ControlGroupDef {
  key: string;
  label: string;
  icon: LucideIcon;
  tabs: ControlTabDef[];
}

export const CONTROL_GROUPS: ControlGroupDef[] = [
  {
    key: "overview",
    label: "Overview",
    icon: Activity,
    tabs: [
      { section: "dashboard", label: "Dashboard" },
      { section: "signins", label: "Sign-ins" },
      { section: "logs", label: "Logs" }
    ]
  },
  {
    key: "library",
    label: "Library",
    icon: LibraryBig,
    tabs: [
      { section: "libraries", label: "Libraries" },
      { section: "storage", label: "Storage" },
      { section: "categories", label: "Categories" },
      { section: "tags", label: "Tags" }
    ]
  },
  {
    key: "members",
    label: "Members",
    icon: UsersRound,
    tabs: [
      { section: "users", label: "Users" },
      { section: "groups", label: "Groups" },
      { section: "invites", label: "Invite links" }
    ]
  },
  {
    key: "security",
    label: "Security",
    icon: ShieldCheck,
    tabs: [
      { section: "security", label: "Overview" },
      { section: "securityPolicies", label: "Policies" },
      { section: "securityTrusted", label: "Trusted networks" },
      { section: "securityBlocked", label: "Blocked IPs" }
    ]
  },
  {
    key: "maintenance",
    label: "Maintenance",
    icon: Wrench,
    tabs: [
      { section: "backup", label: "Backup" },
      { section: "scheduledJobs", label: "Scheduled jobs" },
      { section: "recycleBin", label: "Recycle Bin" }
    ]
  },
  {
    key: "utilities",
    label: "Utilities",
    icon: PocketKnife,
    // Two peers. There were three duplicate pages here — cleanup, photos, folders —
    // which were three views of one install-wide scan: opening any of them rebuilt it
    // and renumbered everything underneath whoever else was looking. Duplicate cleanup
    // holds its own snapshot and does everything they did, so they are gone.
    tabs: [
      { section: "duplicateCleanup", label: "Duplicate cleanup", context: "Gallery" },
      { section: "missingPhotos", label: "Missing photos", context: "Gallery" }
    ]
  },
  {
    key: "settings",
    label: "Settings",
    icon: Settings,
    tabs: [
      { section: "appearance", label: "Appearance" },
      { section: "email", label: "Email" },
      { section: "notifications", label: "Notifications" },
      { section: "readerAccess", label: "Reader access" },
      { section: "about", label: "About" }
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

/** The page's own name — its <h1>. The eyebrow above carries the rest of the path. */
export function sectionTitle(section: ControlSection): string {
  return TAB_BY_SECTION.get(section)?.label ?? "";
}

/** The branch a page sits in, where its group has any. */
const CONTEXT_BY_SECTION = new Map<ControlSection, string>(
  ALL_TABS.flatMap((tab) => (tab.context ? [[tab.section, tab.context] as const] : []))
);

export function sectionContext(section: ControlSection): string | null {
  return CONTEXT_BY_SECTION.get(section) ?? null;
}

/** Where the page sits, as a trail: "Maintenance", or "Utilities › Gallery". */
export function sectionEyebrow(section: ControlSection): string {
  return [groupForSection(section).label, CONTEXT_BY_SECTION.get(section)]
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
  label: string;
  section: ControlSection;
  icon: LucideIcon;
}

/** Icons for the branches. A context without one falls back to its group's. */
const CONTEXT_ICONS: Record<string, LucideIcon> = { Gallery: Image };

export function navChildrenFor(group: ControlGroupDef): ControlNavChild[] {
  const seen = new Map<string, ControlSection>();
  for (const tab of group.tabs) {
    if (tab.context && !seen.has(tab.context)) seen.set(tab.context, tab.section);
  }
  return [...seen].map(([label, section]) => ({
    label,
    section,
    icon: CONTEXT_ICONS[label] ?? group.icon
  }));
}

export function sectionHref(section: ControlSection): string {
  return controlHref(section);
}
