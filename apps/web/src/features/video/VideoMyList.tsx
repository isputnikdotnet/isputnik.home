import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bookmark, BookmarkCheck } from "lucide-react";
import { api } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { Button } from "../../shared/Button";
import { LibraryPageHeader } from "../../shared/LibraryPageHeader";
import { MessageBox } from "../../shared/MessageBox";
import { PosterGrid, type PosterItem } from "./VideoPoster";
import { VideoSectionNav } from "./VideoSectionNav";
import { videoHref, type VideoKind } from "./types";
import "../../styles/video.css";

/** My list, from home (GET /api/video/my-list): only titles this person may see. */
export const MY_LIST_API = "/api/video/my-list";

export interface VideoListItem {
  kind: VideoKind;
  id: string;
  title: string;
  year: number | null;
  poster: string | null;
}

/** A card of a home list (My list, a Collection row). */
export const listPoster = (item: VideoListItem): PosterItem => ({
  key: `${item.kind}:${item.id}`,
  href: videoHref(item.kind, item.id),
  title: item.title,
  sub: item.year ? String(item.year) : null,
  poster: item.poster,
  kind: item.kind === "shows" ? "show" : "movie"
});

// My list on a title's page: on it or not, one press either way.
export function MyListButton({ kind, id }: { kind: VideoKind; id: string }) {
  const { t } = useTranslation();
  const [inList, setInList] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const url = `${MY_LIST_API}/${kind}/${encodeURIComponent(id)}`;

  useEffect(() => {
    let live = true;
    api<{ inList: boolean }>(url)
      .then((answer) => { if (live) setInList(answer.inList); })
      // Not offered where it cannot be read.
      .catch(() => { if (live) setInList(null); });
    return () => { live = false; };
  }, [url]);

  if (inList === null) return null;
  const toggle = async () => {
    setBusy(true);
    try {
      setInList((await api<{ inList: boolean }>(url, { method: inList ? "DELETE" : "PUT" })).inList);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="secondary" aria-pressed={inList} disabled={busy} onClick={() => void toggle()}>
      {inList ? <BookmarkCheck size={16} aria-hidden="true" /> : <Bookmark size={16} aria-hidden="true" />}
      <span>{inList ? t("video.myList.on") : t("video.myList.add")}</span>
    </Button>
  );
}

// My list as a page: what this person means to watch, newest first.
export function VideoMyListPage() {
  const { t } = useTranslation();
  const [items, setItems] = useState<VideoListItem[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    api<{ items: VideoListItem[] }>(MY_LIST_API)
      .then((answer) => { if (live) setItems(answer.items); })
      .catch((err: unknown) => {
        if (!live) return;
        setItems([]);
        setError(err instanceof Error ? err.message : t("video.loadFailed"));
      });
    return () => { live = false; };
  }, [t]);

  return (
    <DashboardShell active="video" sideNav={<VideoSectionNav active="mylist" />}>
      <section className="audiobook-main-page video-page">
        <LibraryPageHeader title={t("video.myList.title")} subtitle={items ? t("video.countTitles", { count: items.length }) : undefined} />
        {error && <MessageBox tone="warning" title={t("video.unavailableTitle")}>{error}</MessageBox>}
        {items && items.length === 0 && !error ? (
          <div className="empty-state library-empty">
            <Bookmark size={48} aria-hidden="true" />
            <h2>{t("video.myList.emptyTitle")}</h2>
            <p className="muted">{t("video.myList.emptyBody")}</p>
          </div>
        ) : (
          <PosterGrid items={(items ?? []).map(listPoster)} />
        )}
      </section>
    </DashboardShell>
  );
}
