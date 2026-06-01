import { useState, useEffect } from "react";

export type ControlSection = "users" | "invites" | "sessions" | "logs" | "status" | "about" | "libraries" | "librariesSpecial" | "librariesStats" | "media" | "otherMedia" | "storage" | "groups" | "jobs" | "backup" | "categories" | "tags";

export type Route =
  | { name: "install" }
  | { name: "login" }
  | { name: "home" }
  | { name: "audiobooks" }
  | { name: "audiobookSaved" }
  | { name: "audiobookBook"; id: string }
  | { name: "audiobookPlayer"; id: string }
  | { name: "audiobookAuthors" }
  | { name: "audiobookAuthorDetail"; personName: string }
  | { name: "audiobookNarrators" }
  | { name: "audiobookNarratorDetail"; personName: string }
  | { name: "audiobookSeries" }
  | { name: "audiobookSeriesDetail"; seriesId: string }
  | { name: "audiobookCategories" }
  | { name: "audiobookCategoryDetail"; categoryKey: string }
  | { name: "audiobookTagDetail"; tagName: string }
  | { name: "audiobookSection"; sectionId: string }
  | { name: "control"; section: ControlSection }
  | { name: "controlCategoryEditor"; categoryId: string | null }
  | { name: "about" }
  | { name: "profile" }
  | { name: "invite"; token: string };

export function getRoute(): Route {
  const path = window.location.pathname;
  const inviteMatch = path.match(/^\/invite\/([^/]+)$/);

  if (inviteMatch) {
    return { name: "invite", token: inviteMatch[1] };
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

  if (path === "/audiobooks/saved") {
    return { name: "audiobookSaved" };
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
    return { name: "audiobookAuthors" };
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

  if (path === "/audiobooks/categories") {
    return { name: "audiobookCategories" };
  }

  const audiobookCategoryDetailMatch = path.match(/^\/audiobooks\/categories\/([^/]+)$/);
  if (audiobookCategoryDetailMatch) {
    return { name: "audiobookCategoryDetail", categoryKey: audiobookCategoryDetailMatch[1] };
  }

  const audiobookSectionMatch = path.match(/^\/audiobooks\/sections\/([^/]+)$/);
  if (audiobookSectionMatch) {
    return { name: "audiobookSection", sectionId: audiobookSectionMatch[1] };
  }

  const audiobookTagDetailMatch = path.match(/^\/audiobooks\/tags\/(.+)$/);
  if (audiobookTagDetailMatch) {
    return { name: "audiobookTagDetail", tagName: decodeURIComponent(audiobookTagDetailMatch[1]) };
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

  if (path === "/control/storage") {
    return { name: "control", section: "storage" };
  }

  // Maintenance defaults to Jobs.
  if (["/control/maintenance", "/control/maintenance/jobs", "/control/system", "/control/jobs"].includes(path)) {
    return { name: "control", section: "jobs" };
  }

  if (["/control/maintenance/backup", "/control/system/backup"].includes(path)) {
    return { name: "control", section: "backup" };
  }

  if (["/control/library/special", "/control/libraries/special"].includes(path)) {
    return { name: "control", section: "librariesSpecial" };
  }

  if (["/control/library/stats", "/control/libraries/stats"].includes(path)) {
    return { name: "control", section: "librariesStats" };
  }

  if (["/control/library", "/control/libraries"].includes(path)) {
    return { name: "control", section: "libraries" };
  }

  if (["/control/media", "/control/photos", "/control/video"].includes(path)) {
    return { name: "control", section: "media" };
  }

  if (path === "/control/other-media") {
    return { name: "control", section: "otherMedia" };
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

  if (path === "/about") {
    return { name: "about" };
  }

  return { name: "home" };
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
