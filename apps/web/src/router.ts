import { useState, useEffect, startTransition } from "react";

// Every leaf destination in the control panel — one value per tab. The six nav
// groups they hang off are described in features/control/nav.ts.
export type ControlSection =
  // Overview
  | "dashboard" | "logs"
  // Library
  | "libraries" | "storage" | "categories" | "tags"
  // Members
  | "users" | "groups" | "invites"
  // Security
  | "security" | "securityPolicies" | "securityTrusted" | "securityBlocked"
  // Maintenance
  | "backup" | "scheduledJobs" | "recycleBin" | "missingPhotos"
  | "duplicateCleanup" | "quotes"
  // Settings
  | "appearance" | "email" | "notifications" | "storySettings" | "maps" | "readerAccess" | "about";

// The canonical address of every control-panel destination. The nav, the tab
// rows and the search palette all link through controlHref(), so this table is
// the single place a section's URL is written down. Every tab has one — nothing
// in the control panel is reachable only by clicking, which is what lets search
// jump straight to a setting.
export const CONTROL_PATHS: Record<ControlSection, string> = {
  dashboard: "/control/overview",
  logs: "/control/overview/logs",

  libraries: "/control/libraries",
  storage: "/control/libraries/storage",
  categories: "/control/libraries/categories",
  tags: "/control/libraries/tags",

  users: "/control/members",
  groups: "/control/members/groups",
  invites: "/control/members/invites",

  security: "/control/security",
  securityPolicies: "/control/security/policies",
  securityTrusted: "/control/security/trusted-networks",
  securityBlocked: "/control/security/blocked-ips",

  backup: "/control/maintenance/backup",
  scheduledJobs: "/control/maintenance/scheduled-jobs",
  recycleBin: "/control/maintenance/recycle-bin",

  // Gallery utilities: tools that work on a library rather than configuring one.
  // One flat row of them, so one flat level of addresses.
  duplicateCleanup: "/control/utilities/duplicate-cleanup",
  missingPhotos: "/control/utilities/missing-photos",
  quotes: "/control/utilities/quotes",

  appearance: "/control/settings",
  email: "/control/settings/email",
  notifications: "/control/settings/notifications",
  storySettings: "/control/settings/stories",
  maps: "/control/settings/maps",
  readerAccess: "/control/settings/reader-access",
  about: "/control/settings/about"
};

export function controlHref(section: ControlSection): string {
  return CONTROL_PATHS[section];
}

/** The story editor's panes as addresses — its nav links to real URLs the same
 *  way the control panel's does, so Back, new-tab and a pasted link all work. */
export function storyEditorHref(storyId: string, chapterId?: string): string {
  if (chapterId) return `/stories/${storyId}/edit/chapters/${chapterId}`;
  return `/stories/${storyId}/edit`;
}

// Addresses the control panel used to live at. They keep resolving so existing
// bookmarks, docs links and the odd typed URL still land somewhere sensible —
// the panel has been reorganised more than once and old links outlive it.
const CONTROL_ALIASES: Record<string, ControlSection> = {
  "/control": "dashboard",
  "/admin": "dashboard",
  "/control/status": "dashboard",
  "/control/database": "dashboard",
  "/control/maintenance/database": "dashboard",
  "/control/system/database": "dashboard",
  // Dashboard briefly lived at its own sub-path before absorbing System (the
  // group's former landing tab) and taking over the group's root address.
  "/control/overview/dashboard": "dashboard",

  // The per-media-type stat pages became one Statistics page, which became the
  // Dashboard's Libraries view. DashboardSection reads these paths to pick it.
  "/control/overview/statistics": "dashboard",
  "/control/status/audiobook-stats": "dashboard",
  "/control/status/stats": "dashboard",
  "/control/status/ebook-stats": "dashboard",
  "/control/status/ebooks-stats": "dashboard",
  "/control/status/gallery-stats": "dashboard",
  "/control/status/galleries-stats": "dashboard",
  "/control/library/stats": "dashboard",
  "/control/libraries/stats": "dashboard",

  // Sign-ins became the Dashboard's opening view — it and the Logins view it
  // absorbed were two readings of one question, and the duplicated chart above
  // them had to be kept in step by hand. Three generations of the Sessions tab's
  // address land there too, since the table with revoke is one of its panels.
  // DashboardSection reads these paths to pick the view.
  "/control/overview/sign-ins": "dashboard",
  "/control/accounts/sessions": "dashboard",
  "/control/sessions": "dashboard",
  "/control/members/sessions": "dashboard",

  // Tasks became a Dashboard view; DashboardSection reads these paths to pick it.
  "/control/overview/tasks": "dashboard",
  "/control/libraries/tasks": "dashboard",
  "/control/libraries/jobs": "dashboard",
  "/control/maintenance/jobs": "dashboard",
  "/control/system": "dashboard",
  "/control/jobs": "dashboard",

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
  // Duplicates left Maintenance for Utilities, spent one release nested under a
  // "Duplicates" tab, and were three pages before Duplicate cleanup absorbed the other
  // two. Every address any of them has ever had lands on the cleanup, because that is
  // now the only page that answers the question they were asked.
  "/control/utilities/duplicate-photos": "duplicateCleanup",
  "/control/utilities/duplicate-folders": "duplicateCleanup",
  "/control/libraries/duplicate-photos": "duplicateCleanup",
  "/control/duplicate-photos": "duplicateCleanup",
  "/control/maintenance/duplicate-photos": "duplicateCleanup",
  "/control/utilities/duplicates/photos": "duplicateCleanup",
  "/control/duplicate-folders": "duplicateCleanup",
  "/control/maintenance/duplicate-folders": "duplicateCleanup",
  "/control/utilities/duplicates/folders": "duplicateCleanup",
  "/control/maintenance/folders-elsewhere": "duplicateCleanup",
  "/control/utilities/stored-elsewhere": "duplicateCleanup",
  "/control/utilities/duplicates/stored-elsewhere": "duplicateCleanup",
  "/control/utilities": "duplicateCleanup",
  "/control/utilities/duplicates": "duplicateCleanup",

  // Config split into the Settings tabs; its old landing page was Appearance.
  "/control/config": "appearance",
  "/control/about": "about"
};

// The gallery's browse views, under the same rule as the control panel's tabs:
// every one is a real address. They were local `view` state until the left nav
// started listing them, at which point items that looked like links but swallowed
// the click became the wrong thing — nothing could be opened in a new tab, and
// the browser's own Back stepped out of the gallery entirely rather than back to
// the previous view.
//
// Folders keeps its own route below rather than a bare path here, because it
// carries the folder being looked at; this table's entry is its root.
export type GalleryView = "timeline" | "memories" | "albums" | "slideshows" | "folder" | "people" | "map";

export const GALLERY_VIEW_PATHS: Record<GalleryView, string> = {
  timeline: "/gallery",
  memories: "/gallery/memories",
  albums: "/gallery/albums",
  slideshows: "/gallery/slideshows",
  folder: "/gallery/folders",
  people: "/gallery/people",
  map: "/gallery/map"
};

export function galleryHref(view: GalleryView): string {
  return GALLERY_VIEW_PATHS[view];
}

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

// Folders is the one gallery view whose address isn't just a path — it is matched
// by its own regex in getRoute — so it is left out of the lookup rather than
// claiming the bare "/gallery/folders" ahead of it. The regex covers that too.
const GALLERY_VIEW_BY_PATH = new Map<string, GalleryView>(
  Object.entries(GALLERY_VIEW_PATHS)
    .filter(([view]) => view !== "folder")
    .map(([view, path]) => [path, view as GalleryView] as const)
);

// Aliases first, canonical paths second: a later entry wins, so a stale alias can
// never shadow the page that actually owns the address.
const CONTROL_SECTION_BY_PATH = new Map<string, ControlSection>([
  ...Object.entries(CONTROL_ALIASES),
  ...Object.entries(CONTROL_PATHS).map(([section, path]) => [path, section as ControlSection] as const)
]);

export type Route =
  | { name: "install" }
  | { name: "welcome" }
  | { name: "login" }
  // Linking a display: the panel it shows, and the screen the phone lands on.
  // Both are reachable signed out — the panel because the device has nobody to
  // sign in as yet, the confirmation because a scan can arrive on a phone that
  // isn't signed in either (it signs in and comes back).
  | { name: "deviceLink" }
  | { name: "deviceLinkConfirm"; userCode: string }
  | { name: "home" }
  | { name: "libraryFeed"; mode: "recent" | "continue" }
  | { name: "audiobooks" }
  | { name: "likes" }
  | { name: "bookmarks" }
  | { name: "quotes" }
  | { name: "downloads" }
  | { name: "audiobookBook"; id: string }
  | { name: "audiobookPlayer"; id: string }
  | { name: "ebooks" }
  | { name: "ebookBook"; id: string }
  | { name: "gallery"; view: GalleryView }
  | { name: "galleryAsset"; id: string }
  | { name: "galleryFolder"; folder: string; libraryId: string | null }
  | { name: "galleryAlbum"; id: string }
  | { name: "gallerySlideshow"; id: string }
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
  | { name: "stories" }
  | { name: "storyDetail"; id: string }
  | { name: "storyChapter"; id: string; chapterId: string }
  | { name: "storyCollection"; id: string }
  | { name: "storyEditor"; id: string; pane: "overview" | "chapter"; chapterId?: string }
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

  if (path === "/welcome") {
    return { name: "welcome" };
  }

  if (path === "/login") {
    return { name: "login" };
  }

  if (path === "/link") {
    return { name: "deviceLink" };
  }

  // The QR's target. The code is matched loosely and normalised by the page —
  // someone reading it off a screen will type it lowercase, or with the dash.
  const deviceCodeMatch = path.match(/^\/link\/([A-Za-z0-9-]{1,20})$/);
  if (deviceCodeMatch) {
    return { name: "deviceLinkConfirm", userCode: deviceCodeMatch[1] };
  }

  if (path === "/audiobooks") {
    return { name: "audiobooks" };
  }

  if (path === "/ebooks") {
    return { name: "ebooks" };
  }

  // Gallery (photos + videos). Every browse view is its own path — see
  // GALLERY_VIEW_PATHS above — and the asset route opens the lightbox over the
  // timeline. Folders is matched separately below since it carries a path.
  const galleryView = GALLERY_VIEW_BY_PATH.get(path);
  if (galleryView) {
    return { name: "gallery", view: galleryView };
  }

  // Safe after the view table above: that is an exact-path Map, so it claims
  // /gallery/albums but never /gallery/albums/<id>.
  const galleryAlbumMatch = path.match(/^\/gallery\/albums\/([^/]+)$/);
  if (galleryAlbumMatch) {
    return { name: "galleryAlbum", id: galleryAlbumMatch[1] };
  }

  const gallerySlideshowMatch = path.match(/^\/gallery\/slideshows\/([^/]+)$/);
  if (gallerySlideshowMatch) {
    return { name: "gallerySlideshow", id: gallerySlideshowMatch[1] };
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

  if (path === "/stories") {
    return { name: "stories" };
  }

  // The editor is its own address, so an author can link straight back into it
  // — and so is each pane inside it: the story's overview, and one address per
  // chapter, since the editor shows a single chapter at a time.
  const storyEditorChapterMatch = path.match(/^\/stories\/([^/]+)\/edit\/chapters\/([^/]+)$/);
  if (storyEditorChapterMatch) {
    return {
      name: "storyEditor",
      id: storyEditorChapterMatch[1],
      pane: "chapter",
      chapterId: storyEditorChapterMatch[2]
    };
  }

  // Story details used to be a pane of its own; its fields now sit on the
  // overview, so the address it had still lands there.
  const storyEditorMatch = path.match(/^\/stories\/([^/]+)\/edit(?:\/details)?$/);
  if (storyEditorMatch) {
    return { name: "storyEditor", id: storyEditorMatch[1], pane: "overview" };
  }

  // A chapter is its own page — /stories/:id is the story's front page.
  const storyChapterMatch = path.match(/^\/stories\/([^/]+)\/chapters\/([^/]+)$/);
  if (storyChapterMatch) {
    return { name: "storyChapter", id: storyChapterMatch[1], chapterId: storyChapterMatch[2] };
  }

  // A collection (the shelf) — matched before the single-segment story detail,
  // or /stories/collections/<id> would read as a story called "collections".
  const storyCollectionMatch = path.match(/^\/stories\/collections\/([^/]+)$/);
  if (storyCollectionMatch) {
    return { name: "storyCollection", id: storyCollectionMatch[1] };
  }

  const storyDetailMatch = path.match(/^\/stories\/([^/]+)$/);
  if (storyDetailMatch) {
    return { name: "storyDetail", id: storyDetailMatch[1] };
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

  // Global, cross-type Likes (audiobooks + ebooks + gallery). Both older paths stay
  // as aliases: /favorites is what this was called before the rename, and it is in
  // people's bookmarks and PWA shortcuts.
  if (path === "/likes" || path === "/favorites" || path === "/audiobooks/saved") {
    return { name: "likes" };
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

  // /inbox is the old "Sent to me" address, kept alive for links already sent.
  if (path === "/shared" || path === "/audiobooks/shared" || path === "/inbox") {
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

// Every in-app pushState carries a depth counter, so goBack() can tell "there is
// app history behind this entry" (history.back() stays on-site) apart from "this
// page was the landing point" (a deep link, a new tab — Back must navigate to a
// fallback or it would leave the app / do nothing). window.history.length can't
// make that call: it counts the previous site's entries too.
function nextHistoryState(): { appNav: number } {
  return { appNav: (window.history.state?.appNav ?? 0) + 1 };
}

// Push a path with the depth stamp but without dispatching popstate — for pages
// that put drill-down state in the address bar while rendering it from their own
// React state (Sign-ins' dive). navigate() is this plus the popstate dispatch.
export function pushPath(path: string) {
  window.history.pushState(nextHistoryState(), "", path);
}

export function navigate(path: string) {
  pushPath(path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

// Navigate without adding a history entry — for a page's INTERNAL views (a
// story's chapters): the whole visit stays one step in the trail, so Back
// leaves to the previous page instead of replaying every view. The current
// entry's state rides along untouched, which keeps goBack()'s "did they get
// here inside the app?" answer honest.
export function replaceNavigate(path: string) {
  window.history.replaceState(window.history.state, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

// The Back button's behaviour everywhere: return to the previous page when the
// visitor navigated here inside the app, else go to the page's natural parent.
export function goBack(fallback: string) {
  if (window.history.state?.appNav) window.history.back();
  else navigate(fallback);
}

// goBack for anchor-shaped Back buttons: a plain left click steps back through
// history; modified clicks fall through to the href (open-in-new-tab keeps
// working, and a new tab has no trail to step back along anyway).
export function followBack(event: React.MouseEvent<HTMLAnchorElement>, fallback: string) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }

  event.preventDefault();
  goBack(fallback);
}

// Where to go once someone has signed in, when they didn't arrive at the sign-in
// screen by choice. Today that means one thing: scanning a device-link QR on a
// phone that happens to be signed out, which without this lands on the home page
// having silently dropped the thing they were trying to do.
//
// sessionStorage, not localStorage — it belongs to this tab and this errand, and
// should not still be waiting a week later. Only a same-origin path is ever
// stored or returned, so a poisoned value can't become an off-site redirect.
const PENDING_PATH_KEY = "isputnik:after-sign-in";

export function rememberPathAfterSignIn(path: string): void {
  if (!path.startsWith("/") || path.startsWith("//")) return;
  try {
    window.sessionStorage.setItem(PENDING_PATH_KEY, path);
  } catch {
    // Private mode, or storage full. The errand is lost, not the sign-in.
  }
}

/** Reads and clears it: an interrupted errand is resumed once, never twice. */
export function takePathAfterSignIn(): string | null {
  try {
    const path = window.sessionStorage.getItem(PENDING_PATH_KEY);
    window.sessionStorage.removeItem(PENDING_PATH_KEY);
    return path && path.startsWith("/") && !path.startsWith("//") ? path : null;
  } catch {
    return null;
  }
}

// Reads one query param off the current URL.
export function queryParam(key: string): string | null {
  return new URLSearchParams(window.location.search).get(key);
}

// Writes one query param without adding a history entry. For view state that
// belongs in the URL so it survives a reload and can be linked — the A–Z strip's
// letter — but must not turn Back into a walk through every letter someone
// clicked. Pass null to drop the param. No popstate is dispatched: the caller
// already holds this state in React, and re-running the router would remount the
// page under it.
export function replaceQuery(key: string, value: string | null) {
  const url = new URL(window.location.href);
  if (value == null || value === "") url.searchParams.delete(key);
  else url.searchParams.set(key, value);
  // Keep the existing state: replacing the entry must not wipe the appNav depth
  // counter goBack() relies on.
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export function followRoute(event: React.MouseEvent<HTMLAnchorElement>, path: string) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }

  event.preventDefault();
  navigate(path);
}

// followRoute for a link between one page's INTERNAL views — a story's chapters
// as a reader steps through them, the editor's panes as an author does. The
// click replaces the history entry instead of stacking one, so the whole visit
// is a single step in the trail and Back (or the page's own way out) leaves to
// wherever the visitor came from rather than replaying the views inside it.
export function followReplace(event: React.MouseEvent<HTMLAnchorElement>, path: string) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }

  event.preventDefault();
  replaceNavigate(path);
}

// Route changes go through startTransition so React keeps the page you are on
// rendered while the next one's lazy chunk arrives, instead of tearing it down
// and falling to the Suspense boundary above the route table. That fallback is
// the auth Shell, so without this every navigation to a not-yet-loaded route
// flashed the sign-in chrome for as long as the chunk took to fetch.
export function useRoute() {
  const [route, setRoute] = useState(getRoute);

  useEffect(() => {
    const onPop = () => startTransition(() => setRoute(getRoute()));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return route;
}
