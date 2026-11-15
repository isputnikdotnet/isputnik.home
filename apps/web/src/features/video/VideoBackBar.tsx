import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import { followBack, followRoute } from "../../router";

// The top of a film, show, set or person page: the way back. Came from the list
// (or from outside the app), it is one arrow naming the list — "← Movies". Came
// from another film, a set or a person, the arrow says "Back" and returns to that
// screen, and the list is a link of its own beside it: "Movies" used to step
// back through every film opened from another, never reaching the list.

/** Whether the screen before this one, inside the app, was the list itself (its filters aside). */
export function cameFromList(list: string): boolean {
  const state = window.history.state as { appNav?: number; from?: string } | null;
  if (!state?.appNav || !state.from) return false;
  const pathOf = (href: string) => new URL(href, window.location.origin).pathname.replace(/\/+$/, "");
  return pathOf(state.from) === pathOf(list);
}

export function VideoBackBar({ list, listLabel }: { list: string; listLabel: string }) {
  const { t } = useTranslation();
  const state = window.history.state as { appNav?: number } | null;
  const deeper = Boolean(state?.appNav) && !cameFromList(list);
  if (!deeper) {
    return (
      <div className="book-detail-topbar">
        <a className="audiobook-back-button" href={list} onClick={(event) => followBack(event, list)}>
          <ArrowLeft size={18} aria-hidden="true" />
          <span>{listLabel}</span>
        </a>
      </div>
    );
  }
  return (
    <div className="book-detail-topbar">
      <a className="audiobook-back-button" href={list} onClick={(event) => followBack(event, list)}>
        <ArrowLeft size={18} aria-hidden="true" />
        <span>{t("video.back")}</span>
      </a>
      <a className="audiobook-back-button video-back-list" href={list} onClick={(event) => followRoute(event, list)}>
        <span>{listLabel}</span>
      </a>
    </div>
  );
}
