import {
  Activity,
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
// A tab may itself hold `tabs` — one more row, beneath the first — for a
// destination that is genuinely several views of one thing rather than several
// pages that happen to be related. Duplicates is the case it exists for: photos,
// folders and stored-elsewhere are three cuts of ONE scan, and they were three
// peers in the nav pretending otherwise. Two rows is the floor and the ceiling;
// a third would be a sitemap, not a navigation.

export interface ControlTabDef {
  /** Where the tab's own link lands. On a tab with sub-tabs this is the first of
   *  them — a parent tab is a landing spot, never a page of its own. */
  section: ControlSection;
  label: string;
  /** Grouping that earns a word in the eyebrow but not a row of its own: one
   *  media type has utilities so far, so "Gallery" says what these work on
   *  without costing a level of navigation. */
  context?: string;
  /** The second row. Present only where one destination has several views. */
  tabs?: ControlTabDef[];
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
      { section: "status", label: "System" },
      { section: "stats", label: "Statistics" },
      { section: "tasks", label: "Tasks" },
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
      { section: "invites", label: "Invite links" },
      { section: "sessions", label: "Sessions" }
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
      { section: "recycleBin", label: "Recycle Bin" },
      { section: "missingPhotos", label: "Missing photos" }
    ]
  },
  {
    key: "utilities",
    label: "Utilities",
    icon: PocketKnife,
    tabs: [
      {
        // One destination, three views of one scan — see the sub-tab note above.
        // Its own link lands on Photos, which is where the scan is started and so
        // where someone arriving with no particular tab in mind should be.
        section: "duplicatePhotos",
        label: "Duplicates",
        context: "Gallery",
        tabs: [
          { section: "duplicatePhotos", label: "Photos" },
          { section: "duplicateFolders", label: "Folders" },
          { section: "duplicateContainedFolders", label: "Stored elsewhere" }
        ]
      }
    ]
  },
  {
    key: "settings",
    label: "Settings",
    icon: Settings,
    tabs: [
      { section: "appearance", label: "Appearance" },
      { section: "email", label: "Email" },
      { section: "readerAccess", label: "Reader access" },
      { section: "about", label: "About" }
    ]
  }
];

/** Every tab in a group, both rows flattened — a parent tab appears once for its
 *  own landing section and once per sub-tab, so a lookup on any section lands on
 *  the tab a person would say they were on. Sub-tabs win, being the deeper answer. */
const tabsOf = (group: ControlGroupDef): ControlTabDef[] =>
  group.tabs.flatMap((tab) => (tab.tabs ? [tab, ...tab.tabs] : [tab]));

/** The tabs of the row a page's own name sits in — the second row where there is
 *  one, the first where there isn't. This is what search indexes and what titles
 *  come from; a parent tab is never a page. */
export const LEAF_TABS: ControlTabDef[] = CONTROL_GROUPS
  .flatMap((group) => group.tabs.flatMap((tab) => tab.tabs ?? [tab]));

const GROUP_BY_SECTION = new Map<ControlSection, ControlGroupDef>(
  CONTROL_GROUPS.flatMap((group) => tabsOf(group).map((tab) => [tab.section, group] as const))
);

const TAB_BY_SECTION = new Map<ControlSection, ControlTabDef>(
  LEAF_TABS.map((tab) => [tab.section, tab] as const)
);

/** The parent tab a section hangs under, where it has one. Both the second tab row
 *  and the extra breadcrumb in the eyebrow come from this. */
const PARENT_BY_SECTION = new Map<ControlSection, ControlTabDef>(
  CONTROL_GROUPS.flatMap((group) => group.tabs.flatMap((tab) =>
    (tab.tabs ?? []).map((sub) => [sub.section, tab] as const)))
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

/** Where the page sits, as a trail: "Utilities", or "Utilities › Gallery ›
 *  Duplicates" for a page that is one view of a larger destination. */
export function sectionEyebrow(section: ControlSection): string {
  const parent = PARENT_BY_SECTION.get(section);
  return [groupForSection(section).label, parent?.context, parent?.label]
    .filter(Boolean)
    .join(" › ");
}

/** The destination a page is one view of, or null where it stands alone. Its
 *  `tabs` are the second row and its label names that row. */
export function parentTabForSection(section: ControlSection): ControlTabDef | null {
  return PARENT_BY_SECTION.get(section) ?? null;
}

export function sectionHref(section: ControlSection): string {
  return controlHref(section);
}
