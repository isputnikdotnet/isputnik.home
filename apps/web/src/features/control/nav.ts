import {
  BookOpen,
  Clapperboard,
  Gamepad2,
  Headphones,
  Network,
  Images,
  LayoutGrid,
  LibraryBig,
  NotebookPen,
  Server,
  Settings,
  ShieldCheck,
  Tags,
  type LucideIcon } from "lucide-react";
import { controlHref, type ControlSection } from "../../router";
// Plain module-level data + lookup functions, not components — they call i18n.t()
// directly rather than the useTranslation() hook (see docs/i18n-plan.md's
// namespace-key typing pitfall #3). `group.key`, `app.key`, `tab.kind` and
// `tab.section` are literal string unions, so the template-literal keys below
// type-check against the declared `control:nav.*` keys (pitfall #4).
import i18n from "../../i18n";

// The shape of the control panel, in one place (docs/control-panel-v2-plan.md).
// The left nav renders the groups, the tab row renders the tabs of the group — or
// of the application workspace — you are standing in, each page takes its eyebrow
// and <h1> from here, and the search palette indexes the lot. Adding a control
// page means adding one tab here; there is nowhere else to keep in sync.
//
// FIVE groups, opened from the panel's title by the Dashboard, which is in none:
//
//   * Infrastructure — running services and containers, their connections and
//     health, tasks, logs and activity.
//   * Libraries & Scanning — which folders supply content, how and when they are
//     scanned.
//   * Applications — a directory of the applications; choosing one opens its
//     WORKSPACE, which holds everything about that application.
//   * Security & Members — people, access, sign-ins.
//   * System Settings — storage, backups and recovery, email, appearance.
//
// v2 replaced the six groups of 4.15–4.86 (Overview, Library, Members, Security,
// Maintenance, Settings), which sorted a feature's controls by KIND: Gallery's
// duplicate cleanup was in Maintenance, its maps in Settings, its phone backup in
// Library. To find everything about Gallery you had to know the taxonomy first.
//
// Every group is a link to its first tab over ONE row of its tabs. Applications is
// the one group whose page is a directory: its workspaces each draw their own ONE
// row (Setup · Device Sync · Organize · Settings — a shared vocabulary, not
// mandatory tabs: an application gets only the tabs it needs, and one with a
// single tab draws no row). Never a row of applications over a row of their tabs.
//
// A tab may own PAGES (4.73): destinations one step down that keep their own
// address and search entry while the tab row stays on their tab, and that open
// with a link back (ControlSectionHead). A page of one thing — a member, a group, a
// library's Manage page — has its own route outside this table and drops the row.
//
// A SHARED page is reached from several workspaces without becoming several
// implementations: Book categories from Ebooks and Audiobooks, Tags from every
// application that uses them. It has ONE address; opened from a workspace it
// carries ?from=<app>, and its eyebrow, selected tab and back link follow that
// (placeOf below). Without ?from= it sits where its canonical entry puts it.

export type GroupKey = "infrastructure" | "libraries" | "applications" | "security" | "settings";
export type AppKey = "gallery" | "videos" | "ebooks" | "audiobooks" | "stories" | "familyTree" | "games" | "shared";
/** The workspace vocabulary. A workspace tab is labelled by its kind; its page's
 *  <h1> is still the section's own name (Settings › "Maps"). */
export type WorkspaceTabKind = "setup" | "deviceSync" | "organize" | "settings";

export interface ControlTabDef {
  section: ControlSection;
  /** Pages under this tab: their own addresses, this tab's row and selection. */
  pages?: ControlSection[];
  /** In an application workspace: which word of the vocabulary the tab is. */
  kind?: WorkspaceTabKind;
}

export interface ControlGroupDef {
  key: GroupKey;
  icon: LucideIcon;
  tabs: ControlTabDef[];
}

export interface ApplicationDef {
  key: AppKey;
  icon: LucideIcon;
  tabs: ControlTabDef[];
}

export const CONTROL_GROUPS: ControlGroupDef[] = [
  {
    key: "infrastructure",
    icon: Server,
    // What runs, whether it is connected, and what it has been doing. Services is
    // the containers' pairing; each application links to Activity, Tasks and Logs
    // with its filter already selected rather than keeping copies of them.
    tabs: [
      { section: "appsSetup" },
      { section: "videoStreaming" },
      { section: "tasks" },
      { section: "scheduledJobs" },
      { section: "logs" },
      { section: "activity" }
    ]
  },
  {
    key: "libraries",
    icon: LibraryBig,
    // Which folders supply content, how they are scanned, and when — each library's
    // Manage page holds its folders, rules and schedule.
    tabs: [
      { section: "libraries" },
      { section: "libraryStats" }
    ]
  },
  {
    key: "applications",
    icon: LayoutGrid,
    // The directory. The workspaces are in APPLICATIONS below.
    tabs: [{ section: "applications" }]
  },
  {
    key: "security",
    icon: ShieldCheck,
    // Who the people are, then who got in, from where, and the rules that decide
    // who may — the applications' access too.
    tabs: [
      { section: "users" },
      { section: "groups" },
      { section: "invites" },
      { section: "security" },
      { section: "signIns" },
      { section: "signInLocations" },
      { section: "securityPolicies" },
      { section: "securityTrusted" },
      { section: "securityBlocked" },
      { section: "appsAccess" }
    ]
  },
  {
    key: "settings",
    icon: Settings,
    // System-wide: how the app looks and mails, where its files live and how much
    // room they take, backups and recovery. Quotes is the home widget's content.
    tabs: [
      { section: "appearance" },
      { section: "email" },
      { section: "notifications" },
      { section: "storage", pages: ["storageContents"] },
      { section: "backup" },
      { section: "recycleBin" },
      { section: "quotes" },
      { section: "about" }
    ]
  }
];

// Each application's workspace. Order is the directory's. An application shows its
// libraries, connections, access and storage use and LINKS to their owners
// (Libraries, Infrastructure, Security, System Settings); it does not own them.
export const APPLICATIONS: ApplicationDef[] = [
  {
    key: "gallery",
    icon: Images,
    tabs: [
      { section: "gallerySetup", kind: "setup" },
      // "Back up my phone photos" is a Gallery task; the libraries it feeds stay in
      // Libraries & Scanning.
      { section: "phoneSync", kind: "deviceSync" },
      { section: "galleryOrganize", kind: "organize", pages: ["duplicateCleanup", "missingPhotos"] },
      { section: "mapSetup", kind: "settings" }
    ]
  },
  {
    key: "videos",
    icon: Clapperboard,
    tabs: [
      { section: "videosSetup", kind: "setup" },
      { section: "genres", kind: "organize" },
      { section: "videoSettings", kind: "settings" }
    ]
  },
  {
    key: "ebooks",
    icon: BookOpen,
    // Book categories' canonical home; Audiobooks opens the same editor with ?from=.
    tabs: [
      { section: "ebooksSetup", kind: "setup" },
      { section: "ebooksOrganize", kind: "organize", pages: ["categories"] }
    ]
  },
  {
    key: "audiobooks",
    icon: Headphones,
    tabs: [
      { section: "audiobooksSetup", kind: "setup" },
      { section: "audiobooksOrganize", kind: "organize" }
    ]
  },
  {
    key: "stories",
    icon: NotebookPen,
    tabs: [
      { section: "storiesSetup", kind: "setup" },
      { section: "storySettings", kind: "settings" }
    ]
  },
  {
    // Import, export and the tree's own settings live in Family Tree itself;
    // Setup links there.
    key: "familyTree",
    icon: Network,
    tabs: [{ section: "familyTreeSetup", kind: "setup" }]
  },
  {
    // A container: Setup shows its connection and links to Infrastructure › Services.
    key: "games",
    icon: Gamepad2,
    tabs: [{ section: "gamesSetup", kind: "setup" }]
  },
  {
    // Not an application: what crosses them. Today, the one tag manager.
    key: "shared",
    icon: Tags,
    tabs: [{ section: "tags", kind: "organize" }]
  }
];

/** Shared pages, and the workspace tab each application opens them under. */
const SHARED_PAGE_PARENTS: Partial<Record<ControlSection, Partial<Record<AppKey, ControlSection>>>> = {
  categories: { ebooks: "ebooksOrganize", audiobooks: "audiobooksOrganize" },
  tags: { gallery: "galleryOrganize", ebooks: "ebooksOrganize", audiobooks: "audiobooksOrganize" }
};

/** Every destination there is: each tab, then the pages under it — what search
 *  indexes and what page titles come from. */
export const ALL_TABS: ControlTabDef[] = [
  ...CONTROL_GROUPS.flatMap((group) => group.tabs),
  ...APPLICATIONS.flatMap((app) => app.tabs)
].flatMap((tab) => [tab, ...(tab.pages ?? []).map((section) => ({ section }))]);

const GROUP_BY_SECTION = new Map<ControlSection, ControlGroupDef>();
const APP_BY_SECTION = new Map<ControlSection, ApplicationDef>();
const PARENT_TAB = new Map<ControlSection, ControlSection>();
const APPLICATIONS_GROUP = CONTROL_GROUPS.find((group) => group.key === "applications")!;

for (const group of CONTROL_GROUPS) {
  for (const tab of group.tabs) {
    for (const section of [tab.section, ...(tab.pages ?? [])]) GROUP_BY_SECTION.set(section, group);
    for (const page of tab.pages ?? []) PARENT_TAB.set(page, tab.section);
  }
}
for (const app of APPLICATIONS) {
  for (const tab of app.tabs) {
    for (const section of [tab.section, ...(tab.pages ?? [])]) {
      GROUP_BY_SECTION.set(section, APPLICATIONS_GROUP);
      APP_BY_SECTION.set(section, app);
    }
    for (const page of tab.pages ?? []) PARENT_TAB.set(page, tab.section);
  }
}

function isAppKey(value: string | null | undefined): value is AppKey {
  return APPLICATIONS.some((app) => app.key === value);
}

/** Where a section sits — given the ?from= it was opened with, for a shared page. */
export interface ControlPlace {
  /** Null for the Dashboard, which is in no group. */
  group: ControlGroupDef | null;
  /** The workspace it is in, if any. */
  app: ApplicationDef | null;
  /** The tab to show selected: the section's own, or the one it is a page of. */
  selected: ControlSection;
  /** The tab it is a page of, or null for a tab itself. */
  parent: ControlSection | null;
}

export function placeOf(section: ControlSection, from?: string | null): ControlPlace {
  const shared = SHARED_PAGE_PARENTS[section];
  if (shared && isAppKey(from)) {
    const parent = shared[from];
    const app = APPLICATIONS.find((candidate) => candidate.key === from)!;
    if (parent) return { group: APPLICATIONS_GROUP, app, selected: parent, parent };
  }
  const parent = PARENT_TAB.get(section) ?? null;
  return {
    group: GROUP_BY_SECTION.get(section) ?? null,
    app: APP_BY_SECTION.get(section) ?? null,
    selected: parent ?? section,
    parent
  };
}

/** The ?from= of the current address — read where a shared page is drawn. */
export function currentFrom(): string | null {
  return new URLSearchParams(window.location.search).get("from");
}

/** The tab a page sits under (Storage contents → Storage), or null for a tab. */
export function parentTab(section: ControlSection, from?: string | null): ControlSection | null {
  return placeOf(section, from).parent;
}

/** The tab to show selected: the section's own, or the one it is a page of. */
export function selectedTab(section: ControlSection, from?: string | null): ControlSection {
  return placeOf(section, from).selected;
}

export function groupForSection(section: ControlSection): ControlGroupDef | null {
  return GROUP_BY_SECTION.get(section) ?? null;
}

/** The workspace's tab row, or the group's: what ControlTabs draws. */
export function tabRowFor(place: ControlPlace): ControlTabDef[] {
  return place.app?.tabs ?? place.group?.tabs ?? [];
}

/** The displayed word for a nav group. Called at render/build time (never cached
 *  at module scope) so it stays reactive to a language switch. */
export function groupLabel(key: GroupKey): string {
  return i18n.t(`control:nav.groups.${key}`);
}

/** An application's name. */
export function appLabel(key: AppKey): string {
  return i18n.t(`control:nav.apps.${key}`);
}

/** One line on what an application is, for the directory. */
export function appDescription(key: AppKey): string {
  return i18n.t(`control:nav.appDescriptions.${key}`);
}

/** A workspace tab's word. */
export function kindLabel(kind: WorkspaceTabKind): string {
  return i18n.t(`control:nav.workspace.${kind}`);
}

/** The displayed word for a tab — also the page's own <h1>. */
export function tabLabel(section: ControlSection): string {
  return i18n.t(`control:nav.tabs.${section}`);
}

/** What a tab reads as in its row: its kind in a workspace, else its own name. */
export function rowLabel(tab: ControlTabDef): string {
  return tab.kind ? kindLabel(tab.kind) : tabLabel(tab.section);
}

/** The page's own name — its <h1>. The eyebrow above carries the rest of the path. */
export function sectionTitle(section: ControlSection): string {
  return tabLabel(section);
}

/** Where the page sits: "System Settings · Storage", "Applications · Gallery ·
 *  Organize", or the panel's own name for the Dashboard. */
export function sectionEyebrow(section: ControlSection, from?: string | null): string {
  const place = placeOf(section, from);
  if (!place.group) return i18n.t("control:nav.aria");
  const parts = [groupLabel(place.group.key)];
  if (place.app) parts.push(appLabel(place.app.key));
  // A page under a tab names that tab, as its row reads ("… · Organize"); a tab
  // itself is selected in the row right above, so its eyebrow stops at the group
  // or the application.
  if (place.parent) {
    const parentDef = tabRowFor(place).find((tab) => tab.section === place.parent);
    parts.push(parentDef ? rowLabel(parentDef) : tabLabel(place.parent));
  }
  return parts.join(" · ");
}

export function sectionHref(section: ControlSection): string {
  return controlHref(section);
}
