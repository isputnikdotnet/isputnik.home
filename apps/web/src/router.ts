import { useState, useEffect } from "react";

export type ControlSection = "users" | "invites" | "sessions" | "logs" | "status" | "statusStats" | "statusEbookStats" | "statusGalleryStats" | "about" | "libraries" | "storage" | "recycleBin" | "groups" | "tasks" | "scheduledJobs" | "missingPhotos" | "backup" | "categories" | "tags" | "config" | "security";

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
  | { name: "familyTree"; focusId?: string }
  | { name: "familyPeople" }
  | { name: "familyPerson"; id: string }
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
  | { name: "profile" }
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

  if (["/admin", "/control"].includes(path)) {
    return { name: "control", section: "status" };
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

  // Family tree: the chart (optionally focused on one person — a real path so
  // re-centering builds browser history), the people list, and person profiles.
  const familyPersonMatch = path.match(/^\/family\/people\/([^/]+)$/);
  if (familyPersonMatch) {
    return { name: "familyPerson", id: familyPersonMatch[1] };
  }

  if (path === "/family/people") {
    return { name: "familyPeople" };
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

  if (["/control/accounts", "/control/users"].includes(path)) {
    return { name: "control", section: "users" };
  }

  if (["/control/accounts/invites", "/control/invites"].includes(path)) {
    return { name: "control", section: "invites" };
  }

  if (["/control/accounts/sessions", "/control/sessions"].includes(path)) {
    return { name: "control", section: "sessions" };
  }

  if (["/control/accounts/groups", "/control/groups"].includes(path)) {
    return { name: "control", section: "groups" };
  }

  if (["/control/activity", "/control/logs"].includes(path)) {
    return { name: "control", section: "logs" };
  }

  // Database info now lives on the Status page; old database paths land there.
  if (["/control/status", "/control/database", "/control/maintenance/database", "/control/system/database"].includes(path)) {
    return { name: "control", section: "status" };
  }

  if (["/control/status/audiobook-stats", "/control/status/stats", "/control/library/stats", "/control/libraries/stats"].includes(path)) {
    return { name: "control", section: "statusStats" };
  }

  if (["/control/status/ebook-stats", "/control/status/ebooks-stats"].includes(path)) {
    return { name: "control", section: "statusEbookStats" };
  }

  if (["/control/status/gallery-stats", "/control/status/galleries-stats"].includes(path)) {
    return { name: "control", section: "statusGalleryStats" };
  }

  if (path === "/control/storage") {
    return { name: "control", section: "storage" };
  }

  if (["/control/recycle-bin", "/control/trash"].includes(path)) {
    return { name: "control", section: "recycleBin" };
  }

  if (path === "/control/config") {
    return { name: "control", section: "config" };
  }

  if (path === "/control/security") {
    return { name: "control", section: "security" };
  }

  // Tasks (formerly "Job logs") live under Libraries; backup under Config. Old paths still resolve.
  if (["/control/libraries/tasks", "/control/libraries/jobs", "/control/maintenance", "/control/maintenance/jobs", "/control/system", "/control/jobs"].includes(path)) {
    return { name: "control", section: "tasks" };
  }

  if (["/control/libraries/scheduled-jobs", "/control/maintenance/scheduled-jobs", "/control/scheduled-jobs"].includes(path)) {
    return { name: "control", section: "scheduledJobs" };
  }

  if (["/control/libraries/missing-photos", "/control/missing-photos"].includes(path)) {
    return { name: "control", section: "missingPhotos" };
  }

  if (["/control/config/backup", "/control/maintenance/backup", "/control/system/backup"].includes(path)) {
    return { name: "control", section: "backup" };
  }

  if (["/control/library", "/control/libraries"].includes(path)) {
    return { name: "control", section: "libraries" };
  }

  // Libraries of every type are managed on the one Libraries page now.
  if (["/control/ebooks", "/control/library/ebooks", "/control/libraries/ebooks"].includes(path)) {
    return { name: "control", section: "libraries" };
  }

  if (path === "/control/categories") {
    return { name: "control", section: "categories" };
  }

  if (["/control/categories/tags", "/control/tags"].includes(path)) {
    return { name: "control", section: "tags" };
  }

  if (path === "/control/categories/new") {
    return { name: "controlCategoryEditor", categoryId: null };
  }

  const controlCategoryEditMatch = path.match(/^\/control\/categories\/([^/]+)$/);
  if (controlCategoryEditMatch) {
    return { name: "controlCategoryEditor", categoryId: controlCategoryEditMatch[1] };
  }

  if (path === "/control/about") {
    return { name: "control", section: "about" };
  }

  if (path === "/profile") {
    return { name: "profile" };
  }

  // Theme moved under the Profile page; keep the old path working as an alias.
  if (path === "/theme") {
    return { name: "profile" };
  }

  if (path === "/about") {
    return { name: "about" };
  }

  if (path === "/help") {
    return { name: "help" };
  }

  return { name: "home" };
}

// Reads the `?from=` referrer param (a path to return to), if present. Used so
// detail pages reached via an in-app link can offer a "Back" to the origin page
// instead of always falling back to their list.
export function getReferrer(): string | null {
  const from = new URLSearchParams(window.location.search).get("from");
  return from && from.startsWith("/") ? from : null;
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
