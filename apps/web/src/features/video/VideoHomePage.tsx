import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Clapperboard, Film, LayoutGrid, Layers, Tv } from "lucide-react";
import { api } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { queryParam, replaceNavigate, replaceQuery } from "../../router";
import { Button } from "../../shared/Button";
import { FacetFilterButton, FacetFilterChips, countActiveFilters, type FacetDef } from "../../shared/FacetFilter";
import { LibraryPageHeader } from "../../shared/LibraryPageHeader";
import { LibraryPageToolbar } from "../../shared/LibraryPageToolbar";
import { MessageBox } from "../../shared/MessageBox";
import { SortMenu } from "../../shared/SortMenu";
import { ContinueWatching } from "./ContinueWatching";
import { VideoBanner } from "./VideoBanner";
import { PosterGrid, PosterRow, type PosterItem } from "./VideoPoster";
import { VideoSectionNav } from "./VideoSectionNav";
import {
  VIDEO_API, videoBrowseHref, videoHref, videoSetHref, yearSpan,
  type VideoKind, type VideoLibraryRef, type VideoMovieSummary, type VideoPage, type VideoSetSummary, type VideoShowSummary, type VideoTitleSummary
} from "./types";
import "../../styles/video.css";

/** About what a row can show before it has to scroll a long way. */
const ROW_SIZE = 30;
/** One page covers a family's whole library; paging comes when one does not. */
const PAGE_SIZE = 200;
/** How long typing rests before the search is asked of the engine. */
const SEARCH_PAUSE_MS = 250;

type Kind = "all" | VideoKind;
type Sort = "title" | "year" | "added";
/** Rows: what's new and what you were watching. Grid: every title that matches.
 *  Sets: films that belong together, one card each (docs/video-sets-plan.md). */
type View = "rows" | "grid" | "sets";
interface VideoFilters {
  libraries: string[];
  genres: string[];
}
const NO_FILTERS: VideoFilters = { libraries: [], genres: [] };

const listParam = (key: string) => (queryParam(key) ?? "").split(",").filter(Boolean);
const oneOf = <T extends string>(value: string | null, options: readonly T[], fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback;

// Video's one page (docs/video-home-rows-plan.md): films and shows together, an
// All · Movies · Shows switch that narrows everything on it, and two views — the
// rows (banner, Continue watching, what's new) and a grid of every title that
// matches. A filter or a search is a question about the whole catalog, so it
// shows the grid; Rows clears them. All of it lives in the address, so a link
// opens on the same view (/videos?kind=movies&genres=Comedy).
export function VideoHomePage() {
  const { t } = useTranslation();
  const [kind, setKind] = useState<Kind>(() => oneOf(queryParam("kind"), ["all", "movies", "shows"] as const, "all"));
  const [view, setView] = useState<View>(() => oneOf(queryParam("view"), ["rows", "grid", "sets"] as const, "rows"));
  const [sort, setSort] = useState<Sort>(() => oneOf(queryParam("sort"), ["title", "year", "added"] as const, "title"));
  const [filters, setFilters] = useState<VideoFilters>(() => ({ libraries: listParam("libraries"), genres: listParam("genres") }));
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [libraries, setLibraries] = useState<VideoLibraryRef[]>([]);
  const [genres, setGenres] = useState<string[]>([]);
  const [movies, setMovies] = useState<VideoMovieSummary[] | null>(null);
  const [shows, setShows] = useState<VideoShowSummary[] | null>(null);
  /** The sets this person can see, for their row; Sets in View waits until there is one. */
  const [setRow, setSetRow] = useState<VideoSetSummary[]>([]);
  const [titles, setTitles] = useState<VideoTitleSummary[] | null>(null);
  const [sets, setSets] = useState<VideoSetSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");

  const filtering = Boolean(query) || countActiveFilters(filters) > 0;
  const shown: View = view === "sets" && kind !== "shows" ? "sets" : view === "grid" || filtering ? "grid" : "rows";
  // Libraries of another kind say nothing once the switch has left it.
  const kindLibraries = useMemo(() => libraries.filter((entry) => kind === "all" || entry.kind === kind), [libraries, kind]);
  const libraryFilter = filters.libraries.filter((id) => kindLibraries.some((entry) => entry.id === id));

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), SEARCH_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  // The address follows the page, without a history step for every click.
  useEffect(() => {
    replaceQuery("kind", kind === "all" ? null : kind);
    replaceQuery("view", view === "rows" ? null : view);
    replaceQuery("sort", sort === "title" ? null : sort);
    replaceQuery("libraries", filters.libraries.join(",") || null);
    replaceQuery("genres", filters.genres.join(",") || null);
  }, [kind, view, sort, filters]);

  useEffect(() => {
    api<{ libraries: VideoLibraryRef[] }>(`${VIDEO_API}/libraries`)
      .then((payload) => setLibraries(payload.libraries))
      .catch(() => setLibraries([]));
    api<VideoPage<VideoSetSummary>>(`${VIDEO_API}/sets?pageSize=${PAGE_SIZE}`)
      .then((payload) => setSetRow(payload.items))
      // An engine from before sets answers 404: no row, no Sets view, nothing else changes.
      .catch(() => setSetRow([]));
  }, []);

  useEffect(() => {
    let live = true;
    api<{ genres: string[] }>(`${VIDEO_API}/genres${kind === "all" ? "" : `?kind=${kind}`}`)
      .then((payload) => { if (live) setGenres(payload.genres); })
      .catch(() => { if (live) setGenres([]); });
    return () => { live = false; };
  }, [kind]);

  // The rows: what is newest in each kind. Asked once; the switch only hides them.
  useEffect(() => {
    let live = true;
    const newest = <T,>(of: VideoKind) => api<VideoPage<T>>(`${VIDEO_API}/${of}?sort=added&pageSize=${ROW_SIZE}`).then((page) => page.items);
    Promise.all([newest<VideoMovieSummary>("movies"), newest<VideoShowSummary>("shows")])
      .then(([nextMovies, nextShows]) => {
        if (!live) return;
        setMovies(nextMovies);
        setShows(nextShows);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setMovies([]);
        setShows([]);
        setError(err instanceof Error ? err.message : t("video.loadFailed"));
      });
    return () => { live = false; };
  }, [t]);

  const librariesKey = libraryFilter.join(",");
  const genresKey = filters.genres.join(",");
  useEffect(() => {
    if (shown === "rows") return;
    let live = true;
    const fail = (err: unknown) => {
      if (!live) return;
      setTitles([]);
      setSets([]);
      setError(err instanceof Error ? err.message : t("video.loadFailed"));
    };
    const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
    if (query) params.set("q", query);
    if (shown === "sets") {
      // Sets narrow by one library at most; two or more ask for them all.
      if (librariesKey && !librariesKey.includes(",")) params.set("library", librariesKey);
      api<VideoPage<VideoSetSummary>>(`${VIDEO_API}/sets?${params}`)
        .then((payload) => {
          if (!live) return;
          setSets(payload.items);
          setTotal(payload.total);
          setError("");
        })
        .catch(fail);
    } else {
      params.set("sort", sort);
      if (kind !== "all") params.set("kind", kind);
      if (librariesKey) params.set("libraries", librariesKey);
      if (genresKey) params.set("genres", genresKey);
      api<VideoPage<VideoTitleSummary>>(`${VIDEO_API}/titles?${params}`)
        .then((payload) => {
          if (!live) return;
          setTitles(payload.items);
          setTotal(payload.total);
          setError("");
        })
        .catch(fail);
    }
    return () => { live = false; };
  }, [shown, kind, sort, query, librariesKey, genresKey, t]);

  const chooseKind = (next: Kind) => {
    setKind(next);
    setTitles(null);
  };
  const chooseView = (next: View) => {
    // Back to the rows is back to the start: a filter there would hide nothing.
    if (next === "rows") {
      setFilters(NO_FILTERS);
      setSearch("");
      setQuery("");
    }
    setView(next);
  };
  const openGrid = (of: Kind) => {
    setKind(of);
    setSort("added");
    setView("grid");
    window.scrollTo({ top: 0 });
  };

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
  const titleItem = (of: VideoKind, item: VideoShowSummary | VideoMovieSummary, sub: string | null = meta(item)): PosterItem => ({
    key: item.id,
    href: videoHref(of, item.id),
    title: item.title,
    sub,
    poster: item.poster,
    icon: of === "shows" ? Tv : Film
  });
  const year = (item: { year: number | null }) => (item.year ? String(item.year) : null);
  const setItem = (set: VideoSetSummary): PosterItem => ({
    key: set.id,
    href: videoSetHref(set.id),
    title: set.name,
    sub: [t("video.films", { count: set.films }), yearSpan(set.firstYear, set.lastYear)].filter(Boolean).join(" · "),
    poster: set.poster,
    icon: Layers
  });
  const viewAll = (onClick: () => void, href: string) => (
    <a className="video-row-more" href={href} onClick={(event) => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey) { event.preventDefault(); onClick(); } }}>
      <span>{t("common.viewAll")}</span>
      <ChevronRight size={16} aria-hidden="true" />
    </a>
  );

  const facetOrder: FacetDef<keyof VideoFilters>[] = [
    // A filter that can only mean "everything" isn't one.
    ...(kindLibraries.length > 1
      ? [{ key: "libraries" as const, title: t("video.facetLibraries"), searchable: false, fixed: kindLibraries.map((entry) => ({ value: entry.id, label: entry.name })) }]
      : []),
    { key: "genres", title: t("video.facetGenres"), searchable: true }
  ];
  const libraryNames = Object.fromEntries(libraries.map((entry) => [entry.id, entry.name]));
  const setsOffered = kind !== "shows" && (setRow.length > 0 || view === "sets");
  const searchPlaceholder = shown === "sets" ? t("video.searchSets")
    : kind === "movies" ? t("video.searchMovies") : kind === "shows" ? t("video.searchShows") : t("video.searchTitles");
  const subtitle = shown === "sets" ? t("video.countSets", { count: total })
    : shown === "grid" && titles ? t("video.countTitles", { count: total }) : undefined;
  const empty = movies !== null && shows !== null && movies.length === 0 && shows.length === 0 && !error;

  return (
    <DashboardShell active="video" sideNav={<VideoSectionNav />}>
      <section className="audiobook-main-page video-page">
        <LibraryPageHeader
          title={t("nav.video")}
          subtitle={subtitle}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder={searchPlaceholder}
        />

        {error && <MessageBox tone="warning" title={t("video.unavailableTitle")}>{error}</MessageBox>}

        <LibraryPageToolbar
          scope={
            <div className="video-kind-tabs" role="tablist" aria-label={t("video.kindAria")}>
              {(["all", "movies", "shows"] as const).map((option) => (
                <Button key={option} variant="tab" selected={kind === option} onClick={() => chooseKind(option)}>
                  {option === "all" ? t("video.kindAll") : option === "movies" ? t("video.movies") : t("video.shows")}
                </Button>
              ))}
            </div>
          }
          tools={
            <>
              <FacetFilterButton
                order={facetOrder}
                facets={{ genres }}
                value={{ libraries: libraryFilter, genres: filters.genres }}
                onChange={setFilters}
                empty={NO_FILTERS}
              />
              {shown === "grid" && (
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
              <SortMenu
                presentation="labelled"
                value={shown}
                ariaLabel={t("video.viewAria")}
                icon={shown === "sets" ? <Layers size={18} aria-hidden="true" /> : <LayoutGrid size={18} aria-hidden="true" />}
                onChange={chooseView}
                options={[
                  { value: "rows", label: t("video.viewRows") },
                  { value: "grid", label: t("video.viewGrid") },
                  ...(setsOffered ? [{ value: "sets" as const, label: t("video.viewSets") }] : [])
                ]}
              />
            </>
          }
        />

        <FacetFilterChips
          value={{ libraries: libraryFilter, genres: filters.genres }}
          onChange={setFilters}
          empty={NO_FILTERS}
          labels={libraryNames}
        />

        {shown === "rows" && (empty ? (
          <div className="empty-state library-empty">
            <Clapperboard size={48} aria-hidden="true" />
            <h2>{t("video.emptyTitle")}</h2>
            <p className="muted">{t("video.emptyBody")}</p>
          </div>
        ) : (
          <>
            <VideoBanner kinds={kind === "all" ? ["movies", "shows"] : [kind]} />
            <ContinueWatching only={kind === "shows" ? "episode" : kind === "movies" ? "movie" : undefined} />
            {kind !== "shows" && (
              <PosterRow
                title={t("video.recentMovies")}
                items={(movies ?? []).map((item) => titleItem("movies", item, year(item)))}
                action={viewAll(() => openGrid("movies"), videoBrowseHref("movies"))}
              />
            )}
            {kind !== "movies" && (
              <PosterRow
                shape="box"
                title={t("video.recentShows")}
                items={(shows ?? []).map((item) => titleItem("shows", item, year(item)))}
                action={viewAll(() => openGrid("shows"), videoBrowseHref("shows"))}
              />
            )}
            {kind !== "shows" && (
              <PosterRow
                title={t("video.viewSets")}
                items={setRow.map(setItem)}
                action={viewAll(() => { setView("sets"); window.scrollTo({ top: 0 }); }, videoBrowseHref("movies", "sets"))}
              />
            )}
          </>
        ))}

        {shown === "grid" && (titles && titles.length === 0 && !error ? (
          <div className="empty-state library-empty">
            <Clapperboard size={48} aria-hidden="true" />
            <h2>{filtering ? t("video.noMatchTitle") : t("video.emptyTitle")}</h2>
            {!filtering && <p className="muted">{t("video.emptyBody")}</p>}
          </div>
        ) : (
          <PosterGrid items={(titles ?? []).map((item) => titleItem(item.kind, item))} />
        ))}

        {shown === "sets" && (sets && sets.length === 0 && !error ? (
          <div className="empty-state library-empty">
            <Layers size={48} aria-hidden="true" />
            <h2>{filtering ? t("video.noMatchTitle") : t("video.setsEmptyTitle")}</h2>
            {!filtering && <p className="muted">{t("video.setsEmptyBody")}</p>}
          </div>
        ) : (
          <PosterGrid items={(sets ?? []).map(setItem)} />
        ))}
      </section>
    </DashboardShell>
  );
}

/** /movies and /shows, the pages before there was one: the same view, at its new address. */
export function VideoBrowseRedirect({ kind }: { kind: VideoKind }) {
  useEffect(() => {
    replaceNavigate(videoBrowseHref(kind, kind === "movies" && queryParam("view") === "sets" ? "sets" : "grid"));
  }, [kind]);
  return null;
}

