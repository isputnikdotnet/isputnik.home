import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Clapperboard, LayoutGrid, LayoutList, Layers, Plus } from "lucide-react";
import { api } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followRoute, queryParam, replaceNavigate, replaceQuery } from "../../router";
import { Button } from "../../shared/Button";
import { FacetFilterButton, FacetFilterChips, countActiveFilters, type FacetDef } from "../../shared/FacetFilter";
import { LibraryPageHeader } from "../../shared/LibraryPageHeader";
import { LibraryPageToolbar } from "../../shared/LibraryPageToolbar";
import { MessageBox } from "../../shared/MessageBox";
import { SortMenu } from "../../shared/SortMenu";
import { VideoBanner } from "./VideoBanner";
import { PosterGrid } from "./VideoPoster";
import { PeopleResults } from "./VideoPeople";
import { VideoRows, setPoster } from "./VideoRows";
import { VideoRowsEditor } from "./VideoRowsEditor";
import { PROFILES_API, WatchingAs, type ProfilesAnswer } from "./VideoProfiles";
import { VideoSectionNav } from "./VideoSectionNav";
import { useTitleCards } from "./VideoTitleCards";
import { useWatchedStamp } from "./watched";
import { VIDEO_HOME_API, VIDEO_ROWS_MAX, newRowId, rowName, type VideoLayout, type VideoRow, type VideoRowKind, type VideoTitlesRow } from "./rows";
import {
  MY_LIST_HREF, VIDEO_API, videoBrowseHref,
  type VideoKind, type VideoLibraryRef, type VideoMovieSummary, type VideoPage, type VideoSetSummary, type VideoShowSummary, type VideoTitleSummary
, type VideoPersonSummary } from "./types";
import "../../styles/video.css";

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
  /** Where this person is in a title: unwatched, progress, watched — any of. */
  watch: string[];
}
const NO_FILTERS: VideoFilters = { libraries: [], genres: [], watch: [] };
const WATCH_STATES = ["unwatched", "progress", "watched"] as const;

const listParam = (key: string) => (queryParam(key) ?? "").split(",").filter(Boolean);
const oneOf = <T extends string>(value: string | null, options: readonly T[], fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback;

// Video's one page (docs/video-home-rows-plan.md): films and shows together, an
// All · Movies · Shows switch that narrows everything on it, and two views — the
// rows the household chose (rows.ts; an admin's Customize and Save as row) under
// the banner, and a grid of every title that matches. A filter or a search is a question about the whole catalog, so it
// shows the grid; Rows clears them. All of it lives in the address, so a link
// opens on the same view (/videos?kind=movies&genres=Comedy).
export function VideoHomePage() {
  const { t } = useTranslation();
  const [kind, setKind] = useState<Kind>(() => oneOf(queryParam("kind"), ["all", "movies", "shows"] as const, "all"));
  const [view, setView] = useState<View>(() => oneOf(queryParam("view"), ["rows", "grid", "sets"] as const, "rows"));
  const [sort, setSort] = useState<Sort>(() => oneOf(queryParam("sort"), ["title", "year", "added"] as const, "title"));
  const [filters, setFilters] = useState<VideoFilters>(() => ({
    libraries: listParam("libraries"),
    genres: listParam("genres"),
    watch: listParam("watch").filter((state) => (WATCH_STATES as readonly string[]).includes(state))
  }));
  /** The engine says where this person is in each title (0.32+): bars, marks and the Watched filter. */
  const [tracked, setTracked] = useState(false);
  const cards = useTitleCards(tracked);
  /** Something was marked by hand: the grid reads its titles again. */
  const marked = useWatchedStamp();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<VideoPersonSummary[]>([]);
  const [libraries, setLibraries] = useState<VideoLibraryRef[]>([]);
  const [genres, setGenres] = useState<string[]>([]);
  const [layout, setLayout] = useState<VideoLayout | null>(null);
  /** How many titles this person can see at all: none is "Nothing here yet". */
  const [catalogTotal, setCatalogTotal] = useState<number | null>(null);
  const [customizing, setCustomizing] = useState(false);
  /** The household's viewing profiles and which one this browser wears. */
  const [profiles, setProfiles] = useState<ProfilesAnswer | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; title: string; body?: string } | null>(null);
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
    replaceQuery("watch", filters.watch.join(",") || null);
  }, [kind, view, sort, filters]);

  useEffect(() => {
    api<ProfilesAnswer>(PROFILES_API).then(setProfiles).catch(() => setProfiles(null));
  }, []);

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

  // The rows the household chose, and whether there is anything to show at all.
  // Each row then asks the engine for its own titles (VideoRows).
  useEffect(() => {
    let live = true;
    api<VideoLayout>(VIDEO_HOME_API)
      .then((next) => { if (live) setLayout(next); })
      .catch(() => { if (live) setLayout({ rows: [], custom: false, mine: false, editable: false }); });
    api<VideoPage<VideoTitleSummary>>(`${VIDEO_API}/titles?pageSize=1`)
      .then((page) => {
        if (!live) return;
        setCatalogTotal(page.total);
        setTracked(page.watch === true);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setCatalogTotal(0);
        setError(err instanceof Error ? err.message : t("video.loadFailed"));
      });
    return () => { live = false; };
  }, [t]);

  const librariesKey = libraryFilter.join(",");
  const genresKey = filters.genres.join(",");
  const watchKey = filters.watch.join(",");
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
      if (watchKey) params.set("watch", watchKey);
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
  }, [shown, kind, sort, query, librariesKey, genresKey, watchKey, marked, t]);

  // People whose name has the words, shown above the titles a search finds.
  useEffect(() => {
    if (!query) {
      setPeople([]);
      return;
    }
    let live = true;
    api<{ people: VideoPersonSummary[] }>(`${VIDEO_API}/people?${new URLSearchParams({ q: query, limit: "12" })}`)
      .then((payload) => { if (live) setPeople(payload.people); })
      // An engine before 0.26 has no people: the search is titles only.
      .catch(() => { if (live) setPeople([]); });
    return () => { live = false; };
  }, [query]);

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
  /** A row's View all: the grid, asking what the row asks. */
  const openRow = (row: VideoRow, under: VideoRowKind) => {
    if (row.type === "sets") setView("sets");
    else if (row.type === "titles") {
      setKind(under);
      setSort(row.sort);
      setFilters({ libraries: row.libraries, genres: row.genres, watch: [] });
      setView("grid");
    }
    window.scrollTo({ top: 0 });
  };
  /** Save as row: the grid's question, as a row at the end of the rows this
   *  person sees — their own; or, for an admin who has none, everyone's. */
  const saveAsRow = async () => {
    if (!layout) return;
    const row: VideoTitlesRow = { id: newRowId(), type: "titles", kind, libraries: libraryFilter, genres: filters.genres, sort };
    const name = rowName(row, t, libraryNames);
    if (layout.rows.length >= VIDEO_ROWS_MAX) {
      setNotice({ tone: "error", title: t("video.rows.saveFailed"), body: t("video.rows.full", { max: VIDEO_ROWS_MAX }) });
      return;
    }
    try {
      const scope = layout.mine || !layout.editable ? "mine" : "everyone";
      setLayout(await api<VideoLayout>(VIDEO_HOME_API, { method: "PUT", body: JSON.stringify({ rows: [...layout.rows, row], scope }) }));
      setNotice({ tone: "success", title: scope === "mine" ? t("video.rows.savedAsRowMine", { name }) : t("video.rows.savedAsRow", { name }) });
    } catch (err) {
      setNotice({ tone: "error", title: t("video.rows.saveFailed"), body: err instanceof Error ? err.message : undefined });
    }
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
  const setItem = (set: VideoSetSummary) => setPoster(set, t);
  const viewAll = (row: VideoRow, under: VideoRowKind) => {
    if (row.type === "continue" || row.type === "collection") return null;
    if (row.type === "mylist") {
      return (
        <a className="video-row-more" href={MY_LIST_HREF} onClick={(event) => followRoute(event, MY_LIST_HREF)}>
          <span>{t("common.viewAll")}</span>
          <ChevronRight size={16} aria-hidden="true" />
        </a>
      );
    }
    const href = row.type === "sets" ? videoBrowseHref("movies", "sets") : rowHref(row, under);
    return (
      <a className="video-row-more" href={href} onClick={(event) => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey) { event.preventDefault(); openRow(row, under); } }}>
        <span>{t("common.viewAll")}</span>
        <ChevronRight size={16} aria-hidden="true" />
      </a>
    );
  };

  const watchLabels: Record<string, string> = {
    unwatched: t("video.mark.stateUnwatched"),
    progress: t("video.mark.stateProgress"),
    watched: t("video.mark.stateWatched")
  };
  const facetOrder: FacetDef<keyof VideoFilters>[] = [
    // A filter that can only mean "everything" isn't one.
    ...(kindLibraries.length > 1
      ? [{ key: "libraries" as const, title: t("video.facetLibraries"), searchable: false, fixed: kindLibraries.map((entry) => ({ value: entry.id, label: entry.name })) }]
      : []),
    { key: "genres", title: t("video.facetGenres"), searchable: true },
    ...(tracked
      ? [{ key: "watch" as const, title: t("video.mark.facet"), searchable: false, fixed: WATCH_STATES.map((state) => ({ value: state, label: watchLabels[state] })) }]
      : [])
  ];
  const libraryNames = Object.fromEntries(libraries.map((entry) => [entry.id, entry.name]));
  const setsOffered = kind !== "shows" && (setRow.length > 0 || view === "sets");
  const searchPlaceholder = shown === "sets" ? t("video.searchSets")
    : kind === "movies" ? t("video.searchMovies") : kind === "shows" ? t("video.searchShows") : t("video.searchTitles");
  const subtitle = shown === "sets" ? t("video.countSets", { count: total })
    : shown === "grid" && titles ? t("video.countTitles", { count: total }) : undefined;
  const empty = catalogTotal === 0 && !error;
  /** Anyone may make the rows their own; the page waits until it knows them. A page
   *  wearing a profile is the household's: only an admin (not locked in it) changes it. */
  const editable = layout !== null && catalogTotal !== 0 && (!layout.profileId || (profiles?.editable ?? false));

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
                value={{ libraries: libraryFilter, genres: filters.genres, watch: filters.watch }}
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
              {profiles && profiles.profiles.length > 0 && (
                <WatchingAs
                  answer={profiles}
                  // Everything on the page is narrowed by the profile: start it again.
                  onSwitched={() => window.location.reload()}
                />
              )}
              {editable && !layout?.profileId && shown === "grid" && !query && (
                <Button variant="toolbar" onClick={() => void saveAsRow()}>
                  <Plus size={18} aria-hidden="true" />
                  <span>{t("video.rows.saveAsRow")}</span>
                </Button>
              )}
              {editable && shown === "rows" && (
                <Button variant="toolbar" onClick={() => setCustomizing(true)}>
                  <LayoutList size={18} aria-hidden="true" />
                  <span>{t("video.rows.customize")}</span>
                </Button>
              )}
            </>
          }
        />

        {notice && (
          <MessageBox tone={notice.tone} title={notice.title} action={<Button variant="text" onClick={() => setNotice(null)}>{t("common.close")}</Button>}>{notice.body}</MessageBox>
        )}

        {query && shown !== "sets" && <PeopleResults people={people} />}

        <FacetFilterChips
          value={{ libraries: libraryFilter, genres: filters.genres, watch: filters.watch }}
          onChange={setFilters}
          empty={NO_FILTERS}
          labels={{ ...libraryNames, ...watchLabels }}
        />

        {cards.dialogs}

        {shown === "rows" && (empty ? (
          <div className="empty-state library-empty">
            <Clapperboard size={48} aria-hidden="true" />
            <h2>{t("video.emptyTitle")}</h2>
            <p className="muted">{t("video.emptyBody")}</p>
          </div>
        ) : (
          <>
            <VideoBanner kinds={kind === "all" ? ["movies", "shows"] : [kind]} />
            {layout && <VideoRows rows={layout.rows} kind={kind} libraryNames={libraryNames} sets={setRow} viewAll={viewAll} />}
          </>
        ))}

        {shown === "grid" && (titles && titles.length === 0 && !error ? (
          <div className="empty-state library-empty">
            <Clapperboard size={48} aria-hidden="true" />
            <h2>{filtering ? t("video.noMatchTitle") : t("video.emptyTitle")}</h2>
            {!filtering && <p className="muted">{t("video.emptyBody")}</p>}
          </div>
        ) : (
          <PosterGrid items={(titles ?? []).map((item) => cards.poster(item, meta(item)))} />
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
      {customizing && layout && (
        <VideoRowsEditor
          layout={layout}
          libraries={libraries}
          // Profiles may have changed in Customize › Profiles: the switch shows them as they are now.
          onClose={() => {
            setCustomizing(false);
            api<ProfilesAnswer>(PROFILES_API).then(setProfiles).catch(() => undefined);
          }}
          onSaved={(next) => {
            setLayout(next);
            setCustomizing(false);
          }}
        />
      )}
    </DashboardShell>
  );
}

/** A row's View all as an address, for a new tab: the grid with the row's question. */
function rowHref(row: VideoTitlesRow, under: VideoRowKind): string {
  const params = new URLSearchParams({ view: "grid" });
  if (under !== "all") params.set("kind", under);
  if (row.sort !== "title") params.set("sort", row.sort);
  if (row.libraries.length > 0) params.set("libraries", row.libraries.join(","));
  if (row.genres.length > 0) params.set("genres", row.genres.join(","));
  return `/videos?${params}`;
}

/** /movies and /shows, the pages before there was one: the same view, at its new address. */
export function VideoBrowseRedirect({ kind }: { kind: VideoKind }) {
  useEffect(() => {
    replaceNavigate(videoBrowseHref(kind, kind === "movies" && queryParam("view") === "sets" ? "sets" : "grid"));
  }, [kind]);
  return null;
}

