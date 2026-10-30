import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Clapperboard, Film, Layers, LibraryBig, Tv } from "lucide-react";
import { api } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate, queryParam, replaceQuery } from "../../router";
import { Button } from "../../shared/Button";
import { LibraryMenu } from "../../shared/LibraryMenu";
import { LibraryPageHeader } from "../../shared/LibraryPageHeader";
import { LibraryPageToolbar } from "../../shared/LibraryPageToolbar";
import { MessageBox } from "../../shared/MessageBox";
import { SortMenu } from "../../shared/SortMenu";
import { ContinueWatching } from "./ContinueWatching";
import { VideoSectionNav } from "./VideoSectionNav";
import {
  VIDEO_API, videoHref, videoSetHref, yearSpan,
  type VideoKind, type VideoLibraryRef, type VideoMovieSummary, type VideoPage, type VideoSetSummary, type VideoShowSummary
} from "./types";
import "../../styles/video.css";

type Sort = "title" | "year" | "added";
/** Movies only: every film, or the sets they make (docs/video-sets-plan.md). */
type View = "films" | "sets";

/** How long typing rests before the search is asked of the engine. */
const SEARCH_PAUSE_MS = 250;
/** One page covers a family's whole library; paging comes when one does not. */
const PAGE_SIZE = 200;

// Shows or movies, from every video library of that kind this person may see.
// The catalog is the video engine's (docs/video-architecture.md); this page
// asks it through the gateway, which tells the engine whose libraries these are.
// Movies has a second view, Sets: films that belong together, one card each; the
// choice lives in the address (?view=sets) so a link opens on it.
export function VideoBrowsePage({ kind }: { kind: VideoKind }) {
  const { t } = useTranslation();
  const [libraries, setLibraries] = useState<VideoLibraryRef[]>([]);
  const [items, setItems] = useState<(VideoShowSummary | VideoMovieSummary)[] | null>(null);
  const [sets, setSets] = useState<VideoSetSummary[] | null>(null);
  /** Whether any set exists for this person: the View control waits until one does. */
  const [hasSets, setHasSets] = useState(false);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [library, setLibrary] = useState("all");
  const [sort, setSort] = useState<Sort>("title");
  const [view, setView] = useState<View>(() => (kind === "movies" && queryParam("view") === "sets" ? "sets" : "films"));
  const showingSets = kind === "movies" && view === "sets";

  // Shows → Movies keeps this page mounted: read the view from the new address.
  useEffect(() => {
    setView(kind === "movies" && queryParam("view") === "sets" ? "sets" : "films");
  }, [kind]);

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
    if (kind !== "movies") return;
    let live = true;
    api<VideoPage<VideoSetSummary>>(`${VIDEO_API}/sets?pageSize=1`)
      .then((payload) => { if (live) setHasSets(payload.total > 0); })
      // An engine from before sets answers 404: no View control, nothing else changes.
      .catch(() => { if (live) setHasSets(false); });
    return () => { live = false; };
  }, [kind]);

  useEffect(() => {
    let live = true;
    // Sets come by name; films in the order chosen.
    const params = new URLSearchParams(showingSets ? { pageSize: String(PAGE_SIZE) } : { sort, pageSize: String(PAGE_SIZE) });
    if (query) params.set("q", query);
    if (library !== "all") params.set("library", library);
    const fail = (err: unknown) => {
      if (!live) return;
      setItems([]);
      setSets([]);
      setError(err instanceof Error ? err.message : t("video.loadFailed"));
    };
    if (showingSets) {
      api<VideoPage<VideoSetSummary>>(`${VIDEO_API}/sets?${params}`)
        .then((payload) => {
          if (!live) return;
          setSets(payload.items);
          setTotal(payload.total);
          setError("");
        })
        .catch(fail);
    } else {
      api<VideoPage<VideoShowSummary | VideoMovieSummary>>(`${VIDEO_API}/${kind}?${params}`)
        .then((payload) => {
          if (!live) return;
          setItems(payload.items);
          setTotal(payload.total);
          setError("");
        })
        .catch(fail);
    }
    return () => { live = false; };
  }, [kind, query, library, sort, showingSets, t]);

  const chooseView = (next: View) => {
    setView(next);
    replaceQuery("view", next === "sets" ? "sets" : null);
  };

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

  const subtitle = showingSets
    ? t("video.countSets", { count: total })
    : kind === "shows" ? t("video.countShows", { count: total }) : t("video.countMovies", { count: total });
  const searchPlaceholder = showingSets ? t("video.searchSets") : kind === "shows" ? t("video.searchShows") : t("video.searchMovies");

  return (
    <DashboardShell active="video" sideNav={<VideoSectionNav activeKey={kind} />}>
      <section className="audiobook-main-page">
        <LibraryPageHeader
          title={title}
          subtitle={subtitle}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder={searchPlaceholder}
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
            <>
              {/* Sets are listed by name; Sort is for films. */}
              {!showingSets && (
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
              )}
              {kind === "movies" && (hasSets || showingSets) && (
                <SortMenu
                  presentation="labelled"
                  value={view}
                  ariaLabel={t("video.viewAria")}
                  icon={<Layers size={18} aria-hidden="true" />}
                  onChange={chooseView}
                  options={[
                    { value: "films", label: t("video.viewFilms") },
                    { value: "sets", label: t("video.viewSets") }
                  ]}
                />
              )}
            </>
          }
        />

        {!filtering && <ContinueWatching only={kind === "shows" ? "episode" : "movie"} />}

        {showingSets ? (
          sets && sets.length === 0 && !error ? (
            <div className="empty-state library-empty">
              <Layers size={48} aria-hidden="true" />
              <h2>{filtering ? t("video.noMatchTitle") : t("video.setsEmptyTitle")}</h2>
              {!filtering && <p className="muted">{t("video.setsEmptyBody")}</p>}
            </div>
          ) : (
            <div className="video-grid">
              {(sets ?? []).map((set) => (
                <Button variant="tile" key={set.id} className="video-card" onClick={() => navigate(videoSetHref(set.id))}>
                  <div className={`video-card-cover${set.poster ? " has-poster" : ""}`} aria-hidden="true">
                    {set.poster ? (
                      <img src={set.poster} alt="" loading="lazy" />
                    ) : (
                      <>
                        <Layers size={22} />
                        <strong>{set.name.slice(0, 2).toUpperCase()}</strong>
                      </>
                    )}
                  </div>
                  <div className="video-card-body">
                    <strong>{set.name}</strong>
                    <span>{[t("video.films", { count: set.films }), yearSpan(set.firstYear, set.lastYear)].filter(Boolean).join(" · ")}</span>
                  </div>
                </Button>
              ))}
            </div>
          )
        ) : items && items.length === 0 && !error ? (
          <div className="empty-state library-empty">
            <Clapperboard size={48} aria-hidden="true" />
            <h2>{filtering ? t("video.noMatchTitle") : t("video.emptyTitle")}</h2>
            {!filtering && <p className="muted">{t("video.emptyBody")}</p>}
          </div>
        ) : (
          <div className="video-grid">
            {(items ?? []).map((item) => (
              <Button variant="tile" key={item.id} className="video-card" onClick={() => navigate(videoHref(kind, item.id))}>
                <div className={`video-card-cover${item.poster ? " has-poster" : ""}`} aria-hidden="true">
                  {item.poster ? (
                    <img src={item.poster} alt="" loading="lazy" />
                  ) : (
                    <>
                      <KindIcon size={22} />
                      <strong>{item.title.slice(0, 2).toUpperCase()}</strong>
                    </>
                  )}
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
