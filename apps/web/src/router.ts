import { useState, useEffect } from "react";

// Every leaf destination in the control panel — one value per tab. The six nav
// groups they hang off are described in features/control/nav.ts.
export type ControlSection =
  // Overview
  | "status" | "stats" | "tasks" | "logs"
  // Library
  | "libraries" | "storage" | "categories" | "tags"
  // Members
  | "users" | "groups" | "invites" | "sessions"
  // Security
  | "security" | "securityPolicies" | "securityTrusted" | "securityBlocked"
  // Maintenance
  | "backup" | "scheduledJobs" | "recycleBin" | "missingPhotos"
  | "duplicatePhotos" | "duplicateFolders" | "duplicateContainedFolders"
  // Settings
  | "appearance" | "email" | "readerAccess" | "about";

// The canonical address of every control-panel destination. The nav, the tab
// rows and the search palette all link through controlHref(), so this table is
// the single place a section's URL is written down. Every tab has one — nothing
// in the control panel is reachable only by clicking, which is what lets search
// jump straight to a setting.
export const CONTROL_PATHS: Record<ControlSection, string> = {
  status: "/control/overview",
  stats: "/control/overview/statistics",
  tasks: "/control/overview/tasks",
  logs: "/control/overview/logs",

  libraries: "/control/libraries",
  storage: "/control/libraries/storage",
  categories: "/control/libraries/categories",
  tags: "/control/libraries/tags",

  users: "/control/members",
  groups: "/control/members/groups",
  invites: "/control/members/invites",
  sessions: "/control/members/sessions",

  security: "/control/security",
  securityPolicies: "/control/security/policies",
  securityTrusted: "/control/security/trusted-networks",
  securityBlocked: "/control/security/blocked-ips",

  backup: "/control/maintenance/backup",
  scheduledJobs: "/control/maintenance/scheduled-jobs",
  recycleBin: "/control/maintenance/recycle-bin",

  // Gallery utilities: tools that work on a library rather than configuring one.
  // One flat row of them, so one flat level of addresses.
  duplicatePhotos: "/control/utilities/duplicate-photos",
  duplicateFolders: "/control/utilities/duplicate-folders",
  duplicateContainedFolders: "/control/utilities/stored-elsewhere",
  missingPhotos: "/control/utilities/missing-photos",

  appearance: "/control/settings",
  email: "/control/settings/email",
  readerAccess: "/control/settings/reader-access",
  about: "/control/settings/about"
};

export function controlHref(section: ControlSection): string {
  return CONTROL_PATHS[section];
}

// Addresses the control panel used to live at. They keep resolving so existing
// bookmarks, docs links and the odd typed URL still land somewhere sensible —
// the panel has been reorganised more than once and old links outlive it.
const CONTROL_ALIASES: Record<string, ControlSection> = {
  "/control": "status",
  "/admin": "status",
  "/control/status": "status",
  "/control/database": "status",
  "/control/maintenance/database": "status",
  "/control/system/database": "status",

  // The per-media-type stat pages are one Statistics page with a type switch now.
  "/control/status/audiobook-stats": "stats",
  "/control/status/stats": "stats",
  "/control/status/ebook-stats": "stats",
  "/control/status/ebooks-stats": "stats",
  "/control/status/gallery-stats": "stats",
  "/control/status/galleries-stats": "stats",
  "/control/library/stats": "stats",
  "/control/libraries/stats": "stats",

  "/control/libraries/tasks": "tasks",
  "/control/libraries/jobs": "tasks",
  "/control/maintenance/jobs": "tasks",
  "/control/system": "tasks",
  "/control/jobs": "tasks",

  "/control/activity": "logs",
  "/control/logs": "logs",

  // Libraries of every type are managed on the one Libraries page.
  "/control/library": "libraries",
  "/control/ebooks": "libraries",
  "/control/library/ebooks": "libraries",
  "/control/libraries/ebooks": "libraries",

  "/control/storage": "storage",
  "/control/categories": "categories",
  "/control/categories/tags": "tags",
  "/control/tags": "tags",

  "/control/accounts": "users",
  "/control/users": "users",
  "/control/accounts/groups": "groups",
  "/control/groups": "groups",
  "/control/accounts/invites": "invites",
  "/control/invites": "invites",
  "/control/accounts/sessions": "sessions",
  "/control/sessions": "sessions",

  // Backup used to hide behind Config; it is Maintenance's first tab now, so the
  // bare /control/maintenance lands there rather than on Tasks.
  "/control/maintenance": "backup",
  "/control/config/backup": "backup",
  "/control/system/backup": "backup",
  "/control/libraries/scheduled-jobs": "scheduledJobs",
  "/control/scheduled-jobs": "scheduledJobs",
  "/control/recycle-bin": "recycleBin",
  "/control/trash": "recycleBin",
  "/control/libraries/missing-photos": "missingPhotos",
  "/control/missing-photos": "missingPhotos",
  "/control/maintenance/missing-photos": "missingPhotos",
  // Duplicates left Maintenance for Utilities, and spent one release nested under a
  // "Duplicates" tab before that row was flattened away. Every address any of them
  // has ever had still lands on the right page.
  "/control/libraries/duplicate-photos": "duplicatePhotos",
  "/control/duplicate-photos": "duplicatePhotos",
  "/control/maintenance/duplicate-photos": "duplicatePhotos",
  "/control/utilities/duplicates/photos": "duplicatePhotos",
  "/control/duplicate-folders": "duplicateFolders",
  "/control/maintenance/duplicate-folders": "duplicateFolders",
  "/control/utilities/duplicates/folders": "duplicateFolders",
  "/control/maintenance/folders-elsewhere": "duplicateContainedFolders",
  "/control/utilities/duplicates/stored-elsewhere": "duplicateContainedFolders",
  "/control/utilities": "duplicatePhotos",
  "/control/utilities/duplicates": "duplicatePhotos",

  // Config split into the Settings tabs; its old landing page was Appearance.
  "/control/config": "appearance",
  "/control/about": "about"
};

// Profile's panels, same rule as the control panel: each is a real address, so a
// device, a two-factor setup, or a share audit can be linked to and returned to.
export type ProfileTab = "account" | "security" | "shares" | "appearance" | "devices";

export const PROFILE_PATHS: Record<ProfileTab, string> = {
  account: "/profile",
  security: "/profile/security",
  shares: "/profile/shares",
  appearance: "/profile/appearance",
  devices: "/profile/devices"
};

export function profileHref(tab: ProfileTab): string {
  return PROFILE_PATHS[tab];
}

const PROFILE_TAB_BY_PATH = new Map<string, ProfileTab>([
  // Theme had its own page before it moved under Profile.
  ["/theme", "appearance" as ProfileTab],
  ...Object.entries(PROFILE_PATHS).map(([tab, path]) => [path, tab as ProfileTab] as const)
]);

// Aliases first, canonical paths second: a later entry wins, so a stale alias can
// never shadow the page that actually owns the address.
const CONTROL_SECTION_BY_PATH = new Map<string, ControlSection>([
  ...Object.entries(CONTROL_ALIASES),
  ...Object.entries(CONTROL_PATHS).map(([section, path]) => [path, section as ControlSection] as const)
]);

export type Route =
  | { name: "install" }
  | { name: "login" }
  | { name: "home" }
  | { name: "libraryFeed"; mode: "recent" | "continue" }
  | { name: "audiobooks" }
  | { name: "favorites" }
  | { name: "bookmarks" }
  | { name: "quotes" }
  | { name: "downloads" }
  | { name: "audiobookBook"; id: string }
  | { name: "audiobookPlayer"; id: string }
  | { name: "ebooks" }
  | { name: "ebookBook"; id: string }
  | { name: "gallery" }
  | { name: "galleryMemories" }
  | { name: "galleryAsset"; id: string }
  | { name: "galleryFolder"; folder: string; libraryId: string | null }
  | { name: "familyTree"; focusId?: string }
  | { name: "familyPeople" }
  | { name: "familyFamilies" }
  | { name: "familyPerson"; id: string }
  | { name: "familyPersonPhotos"; id: string }
  | { name: "ebookAuthorDetail"; personName: string }
  | { name: "ebookSeries" }
  | { name: "ebookSeriesDetail"; seriesId: string }
  | { name: "collections" }
  | { name: "collectionDetail"; id: string }
  | { name: "authors" }
  | { name: "personDetail"; personName: string }
  | { name: "audiobookAuthorDetail"; personName: string }
  | { name: "audiobookNarrators" }
  | { name: "audiobookNarratorDetail"; personName: string }
  | { name: "audiobookSeries" }
  | { name: "audiobookSeriesDetail"; seriesId: string }
  | { name: "categories" }
  | { name: "categoryDetail"; categoryKey: string }
  | { name: "tags" }
  | { name: "tagDetail"; tagName: string }
  | { name: "control"; section: ControlSection }
  | { name: "controlCategoryEditor"; categoryId: string | null }
  | { name: "about" }
  | { name: "help" }
  | { name: "guide"; slug: string }
  | { name: "profile"; tab: ProfileTab }
  | { name: "invite"; token: string }
  | { name: "share"; token: string }
  | { name: "sharedWithMe" };

export function getRoute(): Route {
  const path = window.location.pathname;
  const inviteMatch = path.match(/^\/invite\/([^/]+)$/);

  if (inviteMatch) {
    return { name: "invite", token: inviteMatch[1] };
  }

  const shareMatch = path.match(/^\/share\/([^/]+)$/);
  if (shareMatch) {
    return { name: "share", token: shareMatch[1] };
  }

  if (path === "/install") {
    return { name: "install" };
  }

  if (path === "/login") {
    return { name: "login" };
  }

  if (path === "/audiobooks") {
    return { name: "audiobooks" };
  }

  if (path === "/ebooks") {
    return { name: "ebooks" };
  }

  // Gallery (photos + videos). The asset route opens the lightbox over the
  // timeline; /gallery/memories deep-links into the Memories view (Home tiles).
  if (path === "/gallery") {
    return { name: "gallery" };
  }

  if (path === "/gallery/memories") {
    return { name: "galleryMemories" };
  }

  const galleryAssetMatch = path.match(/^\/gallery\/assets\/([^/]+)$/);
  if (galleryAssetMatch) {
    return { name: "galleryAsset", id: galleryAssetMatch[1] };
  }

  // A folder deep link, so one can be opened in its own tab. The folder is a path
  // relative to its library and keeps its slashes, hence `(.*)` rather than a single
  // segment; the empty tail is the library root. `library` scopes the view, because
  // the same relative folder can exist in more than one gallery library.
  const galleryFolderMatch = path.match(/^\/gallery\/folders\/?(.*)$/);
  if (galleryFolderMatch) {
    return {
      name: "galleryFolder",
      folder: decodeURIComponent(galleryFolderMatch[1]),
      libraryId: new URLSearchParams(window.location.search).get("library")
    };
  }

  // Family tree: the chart (optionally focused on one person — a real path so
  // re-centering builds browser history), the people list, and person profiles.
  // The profile shows a photo preview; this is its "see everything" page — kept
  // inside the family tree because the set (curated attachments + face-cluster
  // photos) has no equivalent view in the gallery.
  const familyPersonPhotosMatch = path.match(/^\/family\/people\/([^/]+)\/photos$/);
  if (familyPersonPhotosMatch) {
    return { name: "familyPersonPhotos", id: familyPersonPhotosMatch[1] };
  }

  const familyPersonMatch = path.match(/^\/family\/people\/([^/]+)$/);
  if (familyPersonMatch) {
    return { name: "familyPerson", id: familyPersonMatch[1] };
  }

  if (path === "/family/people") {
    return { name: "familyPeople" };
  }

  // Family names only — the "pick a branch" entry point into the chart.
  if (path === "/family/families") {
    return { name: "familyFamilies" };
  }

  const familyFocusMatch = path.match(/^\/family\/tree\/([^/]+)$/);
  if (familyFocusMatch) {
    return { name: "familyTree", focusId: familyFocusMatch[1] };
  }

  if (path === "/family") {
    return { name: "familyTree" };
  }

  // Cross-type home feeds behind the dashboard's "View all" links.
  if (path === "/recent") {
    return { name: "libraryFeed", mode: "recent" };
  }

  if (path === "/continue") {
    return { name: "libraryFeed", mode: "continue" };
  }

  if (path === "/collections") {
    return { name: "collections" };
  }

  const collectionDetailMatch = path.match(/^\/collections\/([^/]+)$/);
  if (collectionDetailMatch) {
    return { name: "collectionDetail", id: collectionDetailMatch[1] };
  }

  // Single, cross-type Authors browse (audiobooks + ebooks, with a type filter).
  if (path === "/authors") {
    return { name: "authors" };
  }

  // Canonical, cross-type person page: one author/narrator across audiobooks +
  // ebooks. The per-type /audiobooks|ebooks/(authors|narrators)/:name paths
  // below still resolve and render the same page (kept for existing links).
  const personDetailMatch = path.match(/^\/people\/(.+)$/);
  if (personDetailMatch) {
    return { name: "personDetail", personName: decodeURIComponent(personDetailMatch[1]) };
  }

  const ebookBookMatch = path.match(/^\/ebooks\/books\/([^/]+)$/);
  if (ebookBookMatch) {
    return { name: "ebookBook", id: ebookBookMatch[1] };
  }

  // Old per-type author lists now alias the single unified /authors page.
  if (path === "/ebooks/authors") {
    return { name: "authors" };
  }

  const ebookAuthorDetailMatch = path.match(/^\/ebooks\/authors\/(.+)$/);
  if (ebookAuthorDetailMatch) {
    return { name: "ebookAuthorDetail", personName: decodeURIComponent(ebookAuthorDetailMatch[1]) };
  }

  if (path === "/ebooks/series") {
    return { name: "ebookSeries" };
  }

  const ebookSeriesDetailMatch = path.match(/^\/ebooks\/series\/([^/]+)$/);
  if (ebookSeriesDetailMatch) {
    return { name: "ebookSeriesDetail", seriesId: ebookSeriesDetailMatch[1] };
  }

  // Global, cross-type Favorites (audiobooks + ebooks); old path kept as an alias.
  if (path === "/favorites" || path === "/audiobooks/saved") {
    return { name: "favorites" };
  }

  // Cross-type personal-library pages; old /audiobooks/* paths kept as aliases.
  if (path === "/bookmarks" || path === "/audiobooks/bookmarks") {
    return { name: "bookmarks" };
  }

  if (path === "/quotes") {
    return { name: "quotes" };
  }

  if (path === "/downloads" || path === "/audiobooks/downloads") {
    return { name: "downloads" };
  }

  if (path === "/shared" || path === "/audiobooks/shared") {
    return { name: "sharedWithMe" };
  }

  const audiobookBookMatch = path.match(/^\/audiobooks\/books\/([^/]+)$/);
  if (audiobookBookMatch) {
    return { name: "audiobookBook", id: audiobookBookMatch[1] };
  }

  const audiobookPlayerMatch = path.match(/^\/player\/([^/]+)$/);
  if (audiobookPlayerMatch) {
    return { name: "audiobookPlayer", id: audiobookPlayerMatch[1] };
  }

  if (path === "/audiobooks/authors") {
    return { name: "authors" };
  }

  const audiobookAuthorDetailMatch = path.match(/^\/audiobooks\/authors\/(.+)$/);
  if (audiobookAuthorDetailMatch) {
    return { name: "audiobookAuthorDetail", personName: decodeURIComponent(audiobookAuthorDetailMatch[1]) };
  }

  if (path === "/audiobooks/narrators") {
    return { name: "audiobookNarrators" };
  }

  const audiobookNarratorDetailMatch = path.match(/^\/audiobooks\/narrators\/(.+)$/);
  if (audiobookNarratorDetailMatch) {
    return { name: "audiobookNarratorDetail", personName: decodeURIComponent(audiobookNarratorDetailMatch[1]) };
  }

  if (path === "/audiobooks/series") {
    return { name: "audiobookSeries" };
  }

  const audiobookSeriesDetailMatch = path.match(/^\/audiobooks\/series\/([^/]+)$/);
  if (audiobookSeriesDetailMatch) {
    return { name: "audiobookSeriesDetail", seriesId: audiobookSeriesDetailMatch[1] };
  }

  // Global, cross-type Categories browse (audiobooks + ebooks).
  if (path === "/categories") {
    return { name: "categories" };
  }

  const categoryDetailMatch = path.match(/^\/categories\/([^/]+)$/);
  if (categoryDetailMatch) {
    return { name: "categoryDetail", categoryKey: categoryDetailMatch[1] };
  }

  // Global, cross-type Tags browse (audiobooks + ebooks).
  if (path === "/tags") {
    return { name: "tags" };
  }

  const tagDetailMatch = path.match(/^\/tags\/(.+)$/);
  if (tagDetailMatch) {
    return { name: "tagDetail", tagName: decodeURIComponent(tagDetailMatch[1]) };
  }

  // The whole control panel resolves off the one path table above. The category
  // editor is the single control route that isn't a section, so it is matched
  // after the table — that way /control/libraries/categories/tags-style tab
  // paths win over the editor's `:id` wildcard.
  if (path === "/admin" || path.startsWith("/control")) {
    const section = CONTROL_SECTION_BY_PATH.get(path);
    if (section) {
      return { name: "control", section };
    }

    const categoryEditMatch = path.match(/^\/control\/(?:libraries\/)?categories\/([^/]+)$/);
    if (categoryEditMatch) {
      return { name: "controlCategoryEditor", categoryId: categoryEditMatch[1] === "new" ? null : categoryEditMatch[1] };
    }
  }

  if (path === "/theme" || path === "/profile" || path.startsWith("/profile/")) {
    const tab = PROFILE_TAB_BY_PATH.get(path);
    if (tab) {
      return { name: "profile", tab };
    }
  }

  if (path === "/about") {
    return { name: "about" };
  }

  if (path === "/help") {
    return { name: "help" };
  }

  // One user guide, rendered in-app from the copy of docs/users/ in the build.
  const guideMatch = path.match(/^\/help\/([a-z0-9-]+)$/);
  if (guideMatch) {
    return { name: "guide", slug: guideMatch[1] };
  }

  return { name: "home" };
}

// Reads the `?from=` referrer param (a path to return to), if present. Used so
// detail pages reached via an in-app link can offer a "Back" to the origin page
// instead of always falling back to their list.
//
// The value ends up in a "Back" link's href, so it has to be a path on THIS site
// and nothing else. Anything else would send someone off-site from a link that
// appears on your own domain — a click-through this page effectively vouches for.
// A left click is caught by followRoute, but a middle- or ctrl-click bypasses it
// and follows the raw href, so the value itself must be safe.
//
// Don't pattern-match the raw string for that. Spotting "//evil.com" and
// "/\evil.com" (browsers normalize a backslash in the authority position) leaves
// the same hole one step further along: the URL parser strips ASCII tab, newline
// and carriage return from ANYWHERE in the input before resolving, so
// "/<tab>/evil.com" — which passes any per-character check on the second
// character — lands on evil.com. Resolve it the way the browser will and compare
// the origin instead; that covers this and every other normalisation quirk.
export function getReferrer(): string | null {
  const raw = new URLSearchParams(window.location.search).get("from");
  if (!raw || !raw.startsWith("/")) return null;
  let resolved: URL;
  try {
    resolved = new URL(raw, window.location.origin);
  } catch {
    return null;
  }
  if (resolved.origin !== window.location.origin) return null;
  // The normalized form, so the href is exactly what was just validated.
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

export function navigate(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function followRoute(event: React.MouseEvent<HTMLAnchorElement>, path: string) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }

  event.preventDefault();
  navigate(path);
}

export function useRoute() {
  const [route, setRoute] = useState(getRoute);

  useEffect(() => {
    const onPop = () => setRoute(getRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return route;
}
