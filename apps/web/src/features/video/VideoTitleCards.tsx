import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CheckCheck, Play, RotateCcw } from "lucide-react";
import { navigate } from "../../router";
import type { ActionMenuItem } from "../../shared/ActionMenu";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import type { PosterItem } from "./VideoPoster";
import { progressFraction, videoHref, watchHref, type VideoTitleSummary } from "./types";
import { inProgress, markAllWatched } from "./watched";

// A film's or show's card in browse and in the rows (issue #101): where this
// person is in it, drawn on the poster, and a menu to play it or set that by hand.
// Only what applies is offered: Mark as watched until it is, Mark as unwatched
// once it is (or, for a show, once any of it is), Reset progress for a film left
// part-way. A whole show is asked about first — it is many episodes at once.

interface Pending {
  item: VideoTitleSummary;
  watched: boolean;
}

/** `tracked`: the engine's list said where the person is in each title (0.32+);
 *  without that the cards are plain, as before. */
export function useTitleCards(tracked: boolean): { poster: (item: VideoTitleSummary, sub: string | null) => PosterItem; dialogs: ReactNode } {
  const { t } = useTranslation();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const mark = async (item: VideoTitleSummary, watched: boolean) => {
    setBusy(true);
    setError("");
    try {
      await markAllWatched(item.kind, item.id, watched);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("video.loadFailed"));
    }
    setBusy(false);
    setPending(null);
  };

  const poster = (item: VideoTitleSummary, sub: string | null): PosterItem => {
    const base: PosterItem = {
      key: item.id,
      href: videoHref(item.kind, item.id),
      title: item.title,
      sub,
      poster: item.poster,
      kind: item.kind === "shows" ? "show" : "movie"
    };
    if (!tracked) return base;
    const play: ActionMenuItem[] = item.playId
      ? [{ key: "play", label: t("video.play"), icon: <Play size={15} />, onSelect: () => navigate(watchHref(item.playId!)) }]
      : [];
    const watchedItem = (onSelect: () => void): ActionMenuItem => ({ key: "watched", label: t("video.mark.watched"), icon: <CheckCheck size={15} />, onSelect });
    const unwatchedItem = (onSelect: () => void): ActionMenuItem => ({ key: "unwatched", label: t("video.mark.unwatched"), icon: <RotateCcw size={15} />, onSelect });

    if (item.kind === "shows") {
      const seen = item.watchedEpisodes ?? 0;
      const all = item.episodes > 0 && seen >= item.episodes;
      const started = item.started === true || seen > 0;
      return {
        ...base,
        watched: all,
        fraction: item.episodes > 0 && seen > 0 ? seen / item.episodes : undefined,
        // A show never started says nothing: a count on every poster is noise.
        badge: started && !all ? t("video.mark.unwatchedCount", { count: item.episodes - seen }) : null,
        menu: item.episodes === 0 ? play : [
          ...play,
          ...(all ? [] : [watchedItem(() => setPending({ item, watched: true }))]),
          ...(started ? [unwatchedItem(() => setPending({ item, watched: false }))] : [])
        ]
      };
    }
    const watched = item.progress?.watched === true;
    const partway = inProgress(item.progress);
    return {
      ...base,
      watched,
      fraction: partway ? progressFraction(item.progress) : undefined,
      menu: [
        ...play,
        watched ? unwatchedItem(() => void mark(item, false)) : watchedItem(() => void mark(item, true)),
        ...(partway ? [{ key: "reset", label: t("video.mark.reset"), icon: <RotateCcw size={15} />, onSelect: () => void mark(item, false) }] : [])
      ]
    };
  };

  const dialogs = (
    <>
      {error && <MessageBox tone="error" title={t("video.mark.failedTitle")}>{error}</MessageBox>}
      {pending && (
        <ConfirmDialog
          title={pending.watched ? t("video.mark.showWatchedTitle", { name: pending.item.title }) : t("video.mark.showUnwatchedTitle", { name: pending.item.title })}
          confirmLabel={pending.watched ? t("video.mark.watched") : t("video.mark.unwatched")}
          busyLabel={t("video.mark.saving")}
          busy={busy}
          danger={!pending.watched}
          onConfirm={() => void mark(pending.item, pending.watched)}
          onCancel={() => setPending(null)}
        >
          {pending.watched ? t("video.mark.showWatchedBody") : t("video.mark.showUnwatchedBody")}
        </ConfirmDialog>
      )}
    </>
  );

  return { poster, dialogs };
}
