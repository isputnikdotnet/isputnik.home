import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { ContinueWatching } from "./ContinueWatching";
import { MY_LIST_API, listPoster, type VideoListItem } from "./VideoMyList";
import { PosterRow, type PosterItem } from "./VideoPoster";
import { rowKindUnder, rowName, titlesRowPath, type VideoCollectionRow, type VideoRow, type VideoRowKind, type VideoTitlesRow } from "./rows";
import { videoHref, videoSetHref, yearSpan, type VideoPage, type VideoSetSummary, type VideoTitleSummary } from "./types";

// The video page's rows as the household set them, under the page's
// All · Movies · Shows switch. Each titles row asks the engine for its own
// titles; a row with nothing in it for this person is not drawn.
export function VideoRows({ rows, kind, libraryNames, sets, viewAll }: {
  rows: VideoRow[];
  kind: VideoRowKind;
  libraryNames: Record<string, string>;
  /** The film sets this person can see (the page has them already, for View). */
  sets: VideoSetSummary[];
  /** The row's "View all" link, or none. */
  viewAll: (row: VideoRow, kind: VideoRowKind) => ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <>
      {rows.filter((row) => !row.hidden).map((row) => {
        const under = rowKindUnder(row, kind);
        if (under === null) return null;
        const title = rowName(row, t, libraryNames);
        if (row.type === "continue") {
          return <ContinueWatching key={row.id} title={title} only={under === "shows" ? "episode" : under === "movies" ? "movie" : undefined} />;
        }
        if (row.type === "sets") {
          return <PosterRow key={row.id} title={title} items={sets.map((set) => setPoster(set, t))} action={viewAll(row, under)} />;
        }
        if (row.type === "mylist") {
          return <ListRow key={row.id} url={MY_LIST_API} kind={under} title={title} action={viewAll(row, under)} />;
        }
        if (row.type === "collection") {
          return <ListRow key={row.id} url={collectionRowUrl(row)} kind={under} title={row.title} action={viewAll(row, under)} />;
        }
        return <TitlesRow key={`${row.id}:${under}`} row={row} kind={under} title={title} action={viewAll(row, under)} />;
      })}
    </>
  );
}

function TitlesRow({ row, kind, title, action }: { row: VideoTitlesRow; kind: VideoRowKind; title: string; action: ReactNode }) {
  const [items, setItems] = useState<VideoTitleSummary[]>([]);
  const path = titlesRowPath(row, kind);

  useEffect(() => {
    let live = true;
    api<VideoPage<VideoTitleSummary>>(path)
      .then((page) => { if (live) setItems(page.items); })
      // A row that cannot be read is simply not shown.
      .catch(() => { if (live) setItems([]); });
    return () => { live = false; };
  }, [path]);

  return (
    <PosterRow
      title={title}
      // Shows alone keep the overview's nearly square cards.
      shape={kind === "shows" ? "box" : "poster"}
      items={items.map((item): PosterItem => ({
        key: item.id,
        href: videoHref(item.kind, item.id),
        title: item.title,
        sub: item.year ? String(item.year) : null,
        poster: item.poster,
        kind: item.kind === "shows" ? "show" : "movie"
      }))}
      action={action}
    />
  );
}

const collectionRowUrl = (row: VideoCollectionRow) => `/api/video/home/collections/${encodeURIComponent(row.collectionId)}`;

/** A home list as a row — My list, a Collection — narrowed to the kind shown.
 *  Without a name of its own, a Collection row wears the collection's. */
function ListRow({ url, kind, title, action }: { url: string; kind: VideoRowKind; title?: string; action: ReactNode }) {
  const [list, setList] = useState<{ name?: string; items: VideoListItem[] }>({ items: [] });

  useEffect(() => {
    let live = true;
    api<{ name?: string; items: VideoListItem[] }>(url)
      .then((answer) => { if (live) setList(answer); })
      // A collection deleted since, or not readable: no row.
      .catch(() => { if (live) setList({ items: [] }); });
    return () => { live = false; };
  }, [url]);

  return (
    <PosterRow
      title={title ?? list.name ?? ""}
      items={list.items.filter((item) => kind === "all" || item.kind === kind).map(listPoster)}
      action={action}
    />
  );
}

export function setPoster(set: VideoSetSummary, t: (key: "video.films", options: { count: number }) => string): PosterItem {
  return {
    key: set.id,
    href: videoSetHref(set.id),
    title: set.name,
    sub: [t("video.films", { count: set.films }), yearSpan(set.firstYear, set.lastYear)].filter(Boolean).join(" · "),
    poster: set.poster,
    kind: "movie"
  };
}
