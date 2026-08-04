import {
  Activity,
  LibraryBig,
  Settings,
  ShieldCheck,
  UsersRound,
  Wrench,
  type LucideIcon
} from "lucide-react";
import { controlHref, type ControlSection } from "../../router";

// The shape of the control panel, in one place. The left nav renders the six
// groups, the tab row renders the active group's tabs, each page takes its
// eyebrow from the group label and its <h1> from the tab label, and the search
// palette indexes the lot. Adding a control page means adding one tab here —
// there is nowhere else to keep in sync.
//
// Six groups is the budget. If a seventh looks necessary, the new page almost
// certainly belongs as a tab inside an existing group; a long left nav is what
// this structure exists to prevent.

export interface ControlTabDef {
  section: ControlSection;
  label: string;
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
      { section: "missingPhotos", label: "Missing photos" },
      { section: "duplicatePhotos", label: "Duplicate photos" },
      { section: "duplicateFolders", label: "Duplicate folders" }
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

const GROUP_BY_SECTION = new Map<ControlSection, ControlGroupDef>(
  CONTROL_GROUPS.flatMap((group) => group.tabs.map((tab) => [tab.section, group] as const))
);

const TAB_BY_SECTION = new Map<ControlSection, ControlTabDef>(
  CONTROL_GROUPS.flatMap((group) => group.tabs.map((tab) => [tab.section, tab] as const))
);

export function groupForSection(section: ControlSection): ControlGroupDef {
  // Every section is on exactly one tab, so the lookup can't miss; Overview is
  // the safe landing spot if a future section is ever added without a tab.
  return GROUP_BY_SECTION.get(section) ?? CONTROL_GROUPS[0];
}

/** The page's own name — its <h1>. The group label is the eyebrow above it. */
export function sectionTitle(section: ControlSection): string {
  return TAB_BY_SECTION.get(section)?.label ?? "";
}

/** The group each page sits in — rendered as the eyebrow above its title. */
export function sectionEyebrow(section: ControlSection): string {
  return groupForSection(section).label;
}

export function sectionHref(section: ControlSection): string {
  return controlHref(section);
}
