import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Film, Layers, Tv } from "lucide-react";
import { api } from "../../api";
import { ContinueWatching } from "./ContinueWatching";
import { PosterRow, type PosterItem } from "./VideoPoster";
import { rowKindUnder, rowName, titlesRowPath, type VideoRow, type VideoRowKind, type VideoTitlesRow } from "./rows";
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
      items={items.map((item) => ({
        key: item.id,
        href: videoHref(item.kind, item.id),
        title: item.title,
        sub: item.year ? String(item.year) : null,
        poster: item.poster,
        icon: item.kind === "shows" ? Tv : Film
      }))}
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
    icon: Layers
  };
}
