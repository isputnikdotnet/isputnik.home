import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Clapperboard, Film, LibraryBig, Tv } from "lucide-react";
import { api } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { Button } from "../../shared/Button";
import { LibraryMenu } from "../../shared/LibraryMenu";
import { LibraryPageHeader } from "../../shared/LibraryPageHeader";
import { LibraryPageToolbar } from "../../shared/LibraryPageToolbar";
import { MessageBox } from "../../shared/MessageBox";
import { SortMenu } from "../../shared/SortMenu";
import { VideoSectionNav } from "./VideoSectionNav";
import { VIDEO_API, videoHref, type VideoKind, type VideoLibraryRef, type VideoMovieSummary, type VideoPage, type VideoShowSummary } from "./types";
import "../../styles/video.css";

type Sort = "title" | "year" | "added";

/** How long typing rests before the search is asked of the engine. */
const SEARCH_PAUSE_MS = 250;
/** One page covers a family's whole library; paging comes when one does not. */
const PAGE_SIZE = 200;

// Shows or movies, from every video library of that kind this person may see.
// The catalog is the video engine's (docs/video-architecture.md); this page
// asks it through the gateway, which tells the engine whose libraries these are.
export function VideoBrowsePage({ kind }: { kind: VideoKind }) {
  const { t } = useTranslation();
  const [libraries, setLibraries] = useState<VideoLibraryRef[]>([]);
  const [items, setItems] = useState<(VideoShowSummary | VideoMovieSummary)[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [library, setLibrary] = useState("all");
  const [sort, setSort] = useState<Sort>("title");

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), SEARCH_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    api<{ libraries: VideoLibraryRef[] }>(`${VIDEO_API}/libraries`)
      .then((payload) => setLibraries(payload.libraries.filter((entry) => entry.kind === kind)))
      .catch(() => setLibraries([]));
  }, [kind]);

  useEffect(() => {
    let live = true;
    const params = new URLSearchParams({ sort, pageSize: String(PAGE_SIZE) });
    if (query) params.set("q", query);
    if (library !== "all") params.set("library", library);
    api<VideoPage<VideoShowSummary | VideoMovieSummary>>(`${VIDEO_API}/${kind}?${params}`)
      .then((payload) => {
        if (!live) return;
        setItems(payload.items);
        setTotal(payload.total);
        setError("");
      })
      .catch((err: unknown) => {
        if (!live) return;
        setItems([]);
        setError(err instanceof Error ? err.message : t("video.loadFailed"));
      });
    return () => { live = false; };
  }, [kind, query, library, sort, t]);

  const title = kind === "shows" ? t("video.shows") : t("video.movies");
  const KindIcon = kind === "shows" ? Tv : Film;
  const filtering = Boolean(query) || library !== "all";

  const meta = (item: VideoShowSummary | VideoMovieSummary) => {
    const parts: string[] = [];
    if (item.year) parts.push(String(item.year));
    if ("episodes" in item) {
      parts.push(t("video.seasons", { count: item.seasons }));
      parts.push(t("video.episodes", { count: item.episodes }));
    } else if (item.runtimeMinutes) {
      parts.push(t("video.minutes", { count: item.runtimeMinutes }));
    }
    return parts.join(" · ");
  };

  return (
    <DashboardShell active="video" sideNav={<VideoSectionNav activeKey={kind} />}>
      <section className="audiobook-main-page">
        <LibraryPageHeader
          title={title}
          subtitle={kind === "shows" ? t("video.countShows", { count: total }) : t("video.countMovies", { count: total })}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder={kind === "shows" ? t("video.searchShows") : t("video.searchMovies")}
        />

        {error && <MessageBox tone="warning" title={t("video.unavailableTitle")}>{error}</MessageBox>}

        <LibraryPageToolbar
          scope={libraries.length > 1 && (
            <LibraryMenu
              value={library}
              options={[{ value: "all", label: t("video.allLibraries") }, ...libraries.map((entry) => ({ value: entry.id, label: entry.name }))]}
              icon={<LibraryBig size={19} aria-hidden="true" />}
              label={t("video.library")}
              onChange={setLibrary}
            />
          )}
          tools={
            <SortMenu
              presentation="labelled"
              value={sort}
              ariaLabel={t("video.sortAria")}
              onChange={setSort}
              options={[
                { value: "title", label: t("video.sortTitle") },
                { value: "year", label: t("video.sortYear") },
                { value: "added", label: t("video.sortAdded") }
              ]}
            />
          }
        />

        {items && items.length === 0 && !error ? (
          <div className="empty-state library-empty">
            <Clapperboard size={48} aria-hidden="true" />
            <h2>{filtering ? t("video.noMatchTitle") : t("video.emptyTitle")}</h2>
            {!filtering && <p className="muted">{t("video.emptyBody")}</p>}
          </div>
        ) : (
          <div className="video-grid">
            {(items ?? []).map((item) => (
              <Button variant="tile" key={item.id} className="video-card" onClick={() => navigate(videoHref(kind, item.id))}>
                <div className="video-card-cover" aria-hidden="true">
                  <KindIcon size={22} />
                  <strong>{item.title.slice(0, 2).toUpperCase()}</strong>
                </div>
                <div className="video-card-body">
                  <strong>{item.title}</strong>
                  <span>{meta(item)}</span>
                </div>
              </Button>
            ))}
          </div>
        )}
      </section>
    </DashboardShell>
  );
}
