import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Bookmark, BookmarkCheck, CheckCheck, Download, HardDrive, Play, RotateCcw } from "lucide-react";
import { api } from "../../api";
import { useVideoDownloads } from "../../offline/useVideoDownloads";
import { navigate } from "../../router";
import type { ActionMenuItem } from "../../shared/ActionMenu";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import { DownloadVideoModal, movieDownloadTarget, type VideoDownloadTarget } from "./VideoDownloads";
import { MY_LIST_API, type VideoListItem } from "./VideoMyList";
import type { PosterItem } from "./VideoPoster";
import { VIDEO_API, progressFraction, videoHref, watchHref, type VideoMovie, type VideoTitleSummary } from "./types";
import { inProgress, markAllWatched } from "./watched";

// A film's or show's card in browse and in the rows (issue #101): where this
// person is in it, drawn on the poster, and a menu beside its name to play it,
// set that by hand, put it on My list or download it. Only what applies is
// offered: Mark as watched until it is, Mark as unwatched once it is (or, for a
// show, once any of it is), Reset progress for a film left part-way. A whole
// show is asked about first — it is many episodes at once.

interface Pending {
  item: VideoTitleSummary;
  watched: boolean;
}

const listKey = (item: { kind: string; id: string }) => `${item.kind}:${item.id}`;

/** `tracked`: the engine's list said where the person is in each title (0.32+);
 *  without that the cards are plain, as before. */
export function useTitleCards(tracked: boolean): { poster: (item: VideoTitleSummary, sub: string | null) => PosterItem; dialogs: ReactNode } {
  const { t } = useTranslation();
  const downloads = useVideoDownloads();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** What is on My list, to say Add or Remove; null where the list can't be read. */
  const [listed, setListed] = useState<Set<string> | null>(null);
  /** The film whose Download dialog is open. */
  const [downloading, setDownloading] = useState<VideoDownloadTarget | null>(null);

  useEffect(() => {
    if (!tracked) return;
    let live = true;
    api<{ items: VideoListItem[] }>(MY_LIST_API)
      .then((answer) => { if (live) setListed(new Set(answer.items.map(listKey))); })
      .catch(() => { if (live) setListed(null); });
    return () => { live = false; };
  }, [tracked]);

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

  const toggleListed = async (item: VideoTitleSummary) => {
    const on = listed?.has(listKey(item)) ?? false;
    try {
      const answer = await api<{ inList: boolean }>(`${MY_LIST_API}/${item.kind}/${encodeURIComponent(item.id)}`, { method: on ? "DELETE" : "PUT" });
      setListed((current) => {
        const next = new Set(current ?? []);
        if (answer.inList) next.add(listKey(item));
        else next.delete(listKey(item));
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("video.loadFailed"));
    }
  };

  /** A film's files are known only to its own page: read it, then ask which copy. */
  const openDownload = async (item: VideoTitleSummary) => {
    try {
      setDownloading(movieDownloadTarget(await api<VideoMovie>(`${VIDEO_API}/movies/${encodeURIComponent(item.id)}`), t));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("video.loadFailed"));
    }
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
    const onList = listed?.has(listKey(item)) ?? false;
    const myList: ActionMenuItem[] = listed
      ? [{ key: "mylist", label: onList ? t("video.myList.remove") : t("video.myList.addTo"), icon: onList ? <BookmarkCheck size={15} /> : <Bookmark size={15} />, onSelect: () => void toggleListed(item) }]
      : [];

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
        menu: item.episodes === 0 ? [...play, ...myList] : [
          ...play,
          ...(all ? [] : [watchedItem(() => setPending({ item, watched: true }))]),
          ...(started ? [unwatchedItem(() => setPending({ item, watched: false }))] : []),
          ...myList
        ]
      };
    }
    const watched = item.progress?.watched === true;
    const partway = inProgress(item.progress);
    // Here already, or on its way: Downloads has the rest. A film in parts is known by its first.
    const kept = downloads.get(item.playId ?? item.id) ?? downloads.get(item.id);
    const download: ActionMenuItem = kept && kept.state !== "failed"
      ? { key: "download", label: kept.state === "complete" ? t("video.download.onDevice") : t("video.download.underWay"), icon: <HardDrive size={15} />, onSelect: () => navigate("/downloads") }
      : { key: "download", label: t("video.download.open"), icon: <Download size={15} />, onSelect: () => void openDownload(item) };
    return {
      ...base,
      watched,
      fraction: partway ? progressFraction(item.progress) : undefined,
      menu: [
        ...play,
        watched ? unwatchedItem(() => void mark(item, false)) : watchedItem(() => void mark(item, true)),
        ...(partway ? [{ key: "reset", label: t("video.mark.reset"), icon: <RotateCcw size={15} />, onSelect: () => void mark(item, false) }] : []),
        ...myList,
        download
      ]
    };
  };

  const dialogs = (
    <>
      {error && <MessageBox tone="error" title={t("video.mark.failedTitle")}>{error}</MessageBox>}
      {downloading && <DownloadVideoModal target={downloading} onClose={() => setDownloading(null)} />}
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
