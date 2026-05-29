import { useState, useEffect } from "react";

export type ControlSection = "users" | "invites" | "sessions" | "logs" | "status" | "about" | "libraries" | "storage" | "groups" | "jobs" | "database";

export type Route =
  | { name: "install" }
  | { name: "login" }
  | { name: "home" }
  | { name: "audiobooks" }
  | { name: "audiobookBook"; id: string }
  | { name: "audiobookAuthors" }
  | { name: "audiobookAuthorDetail"; personName: string }
  | { name: "audiobookNarrators" }
  | { name: "audiobookNarratorDetail"; personName: string }
  | { name: "audiobookSeries" }
  | { name: "audiobookSeriesDetail"; seriesId: string }
  | { name: "audiobookGenres" }
  | { name: "audiobookGenreDetail"; genreId: string }
  | { name: "control"; section: ControlSection }
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

  const audiobookBookMatch = path.match(/^\/audiobooks\/books\/([^/]+)$/);
  if (audiobookBookMatch) {
    return { name: "audiobookBook", id: audiobookBookMatch[1] };
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

  if (path === "/audiobooks/genres") {
    return { name: "audiobookGenres" };
  }

  const audiobookGenreDetailMatch = path.match(/^\/audiobooks\/genres\/([^/]+)$/);
  if (audiobookGenreDetailMatch) {
    return { name: "audiobookGenreDetail", genreId: audiobookGenreDetailMatch[1] };
  }

  if (path === "/control/users") {
    return { name: "control", section: "users" };
  }

  if (path === "/control/invites") {
    return { name: "control", section: "invites" };
  }

  if (path === "/control/sessions") {
    return { name: "control", section: "sessions" };
  }

  if (path === "/control/groups") {
    return { name: "control", section: "groups" };
  }

  if (["/control/activity", "/control/logs"].includes(path)) {
    return { name: "control", section: "logs" };
  }

  if (path === "/control/status") {
    return { name: "control", section: "status" };
  }

  if (path === "/control/storage") {
    return { name: "control", section: "storage" };
  }

  if (path === "/control/jobs") {
    return { name: "control", section: "jobs" };
  }

  if (path === "/control/database") {
    return { name: "control", section: "database" };
  }

  if (["/control/library", "/control/libraries"].includes(path)) {
    return { name: "control", section: "libraries" };
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
