import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRoute } from "../src/router";
import { renderSignedIn } from "./helpers/session";

// Video in the home app (docs/video-architecture.md): the pages over the
// engine's catalog, and Add library → Video. The engine is reached through
// /video/api; here api() answers for it.

// hls.js stands in for itself: what the player hands it is what matters here.
const hlsCalls = vi.hoisted(() => ({ config: null as unknown, source: "", attached: null as unknown, destroyed: 0 }));
vi.mock("hls.js", () => {
  class FakeHls {
    static isSupported() { return true; }
    static Events = { MANIFEST_PARSED: "hlsManifestParsed", ERROR: "hlsError" };
    static ErrorTypes = { MEDIA_ERROR: "mediaError" };
    constructor(config: unknown) { hlsCalls.config = config; }
    on() { return undefined; }
    loadSource(url: string) { hlsCalls.source = url; }
    attachMedia(element: unknown) { hlsCalls.attached = element; }
    recoverMediaError() { return undefined; }
    destroy() { hlsCalls.destroyed += 1; }
  }
  return { default: FakeHls };
});

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});

const { api } = await import("../src/api");
const { VideoHomePage, VideoBrowseRedirect } = await import("../src/features/video/VideoHomePage");
const { MyListButton, VideoMyListPage } = await import("../src/features/video/VideoMyList");
const { VideoTitlePage } = await import("../src/features/video/VideoTitlePage");
const { VideoPlayerPage } = await import("../src/features/video/VideoPlayerPage");
const { VideoSetPage } = await import("../src/features/video/VideoSetPage");
const { LibraryWizard } = await import("../src/features/control/libraries/LibraryWizard");
const { resetVideoAvailable } = await import("../src/app/useVideoAvailable");
const { BackdropChooser } = await import("../src/features/video/TitlePictures");
const mockApi = vi.mocked(api);

const at = (url: string) => window.history.replaceState({}, "", url);

/** The Edit dialog's answer for a title with no edits: every field as found. */
const editState = (title: { title: string; originalTitle: string | null; year: number | null; plot: string | null; genres: string[] }) => ({
  kind: "movies",
  title: { edited: null, automatic: title.title },
  originalTitle: { edited: null, automatic: title.originalTitle },
  sortTitle: { edited: null, automatic: title.title.toLowerCase() },
  year: { edited: null, automatic: title.year },
  plot: { edited: null, automatic: title.plot },
  genres: { edited: null, automatic: title.genres }
});

beforeEach(() => {
  mockApi.mockReset();
  at("/");
});

describe("video routes", () => {
  it("reads Shows, Movies and one title of either, never under /video", () => {
    at("/videos");
    expect(getRoute()).toEqual({ name: "videoHome" });
    at("/shows");
    expect(getRoute()).toEqual({ name: "videoBrowse", kind: "shows" });
    at("/movies");
    expect(getRoute()).toEqual({ name: "videoBrowse", kind: "movies" });
    at("/shows/abc%20d");
    expect(getRoute()).toEqual({ name: "videoTitle", kind: "shows", id: "abc d" });
    at("/movies/m1");
    expect(getRoute()).toEqual({ name: "videoTitle", kind: "movies", id: "m1" });
    at("/watch/e1");
    expect(getRoute()).toEqual({ name: "videoWatch", id: "e1" });
  });
});

const shows = {
  items: [
    { id: "s1", libraryId: "lib_tv", title: "Counterpart", year: 2017, imdbId: null, genres: [], seasons: 2, episodes: 20 },
    { id: "s2", libraryId: "lib_kids", title: "Радар", year: 2026, imdbId: "tt33022834", genres: ["Драма"], seasons: 1, episodes: 9 }
  ],
  total: 2,
  page: 1,
  pageSize: 200
};

const movie = { id: "m1", libraryId: "lib_mov", title: "The General", originalTitle: null, year: 1926, plot: "A train.", genres: [], runtimeMinutes: 67, imdbId: null, tmdbId: null, source: "nfo", direct: "yes", progress: null, backdrop: "/video/api/art/m1/backdrop", poster: "/video/api/art/m1/poster" };

/** The rows nobody has changed: what home answers until an admin does. */
const DEFAULT_ROWS = [
  { id: "continue", type: "continue" },
  { id: "new-movies", type: "titles", kind: "movies", libraries: [], genres: [], sort: "added" },
  { id: "new-shows", type: "titles", kind: "shows", libraries: [], genres: [], sort: "added" },
  { id: "sets", type: "sets" }
];
const homeLayout = (over: Record<string, unknown> = {}) => ({ rows: DEFAULT_ROWS, custom: false, mine: false, editable: false, ...over });

/** The page's rows: home's layout, and each row's titles from the engine, by the
 *  kind it asks for. Undefined for anything else. */
function rowsAnswer(path: string, films: object[], series: object[]) {
  if (path === "/api/video/home") return homeLayout();
  if (!path.startsWith("/video/api/titles?")) return undefined;
  const kind = new URLSearchParams(path.split("?")[1]).get("kind");
  const items = [
    ...(kind === "shows" ? [] : films.map((film) => ({ kind: "movies", ...film }))),
    ...(kind === "movies" ? [] : series.map((show) => ({ kind: "shows", ...show })))
  ];
  return { items, total: items.length, page: 1, pageSize: 30 };
}

describe("the overview", () => {
  const answer = (over: Record<string, unknown> = {}) => mockApi.mockImplementation((async (path: string) => {
    if (path in over) return over[path];
    if (path === "/video/api/continue") return { items: [] };
    const rows = rowsAnswer(path, [{ ...movie, seasons: undefined }], shows.items);
    if (rows) return rows;
    if (path.startsWith("/video/api/movies?")) return { items: [{ ...movie, seasons: undefined }], total: 1, page: 1, pageSize: 30 };
    if (path.startsWith("/video/api/shows?")) return shows;
    if (path === "/video/api/movies/m1") return movie;
    throw new Error(`unexpected ${path}`);
  }) as never);

  it("leads with the newest title when nothing is in progress, over rows of what is new", async () => {
    answer();
    renderSignedIn(<VideoHomePage />);
    const banner = await screen.findByRole("region", { name: "The General" });
    expect(banner.querySelector("img")).toHaveAttribute("src", "/video/api/art/m1/backdrop");
    expect(screen.getByRole("link", { name: "Play" })).toHaveAttribute("href", "/watch/m1");
    expect(screen.getByRole("link", { name: "More" })).toHaveAttribute("href", "/movies/m1");
    expect(await screen.findByRole("heading", { name: "Recently added movies" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recently added shows" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Counterpart/ })).toHaveAttribute("href", "/shows/s1");
  });

  it("leads with what is in progress, saying how far along it is", async () => {
    answer({
      "/video/api/continue": { items: [{ id: "m1", type: "movie", title: "The General", show: null, season: null, episode: null, position: 600, duration: 1800, resume: true, updatedAt: "2026-11-01T00:00:00.000Z" }] }
    });
    renderSignedIn(<VideoHomePage />);
    await screen.findByRole("region", { name: "The General" });
    expect(screen.getByRole("link", { name: "Continue" })).toHaveAttribute("href", "/watch/m1");
    expect(screen.getByText("20:00 left")).toBeInTheDocument();
  });

  it("shows what you were watching as wide frames: an episode's own still, a film's backdrop", async () => {
    resetVideoAvailable();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ enabled: true }), { status: 200 }));
    try {
      answer({
        "/video/api/continue": { items: [
          { id: "e2", type: "episode", title: "Birds of a Feather", show: { id: "s1", title: "Counterpart" }, season: 1, episode: 2, position: 600, duration: 3600, resume: true, updatedAt: "2026-11-01T00:00:00.000Z" },
          { id: "m1", type: "movie", title: "The General", show: null, season: null, episode: null, position: 600, duration: 1800, resume: true, updatedAt: "2026-10-31T00:00:00.000Z" }
        ] },
        "/video/api/shows/s1": {
          id: "s1", title: "Counterpart", plot: null, poster: "/video/api/art/s1/poster", backdrop: "/video/api/art/s1/backdrop", nextUp: null,
          seasons: [{ number: 1, episodes: [{ id: "e2", season: 1, episode: 2, still: "/video/api/art/e2/still" }] }]
        }
      });
      renderSignedIn(<VideoHomePage />);
      const row = (await screen.findByRole("heading", { name: "Continue watching" })).closest("section")!;
      await waitFor(() => expect([...row.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual(["/video/api/art/e2/still", "/video/api/art/m1/backdrop"]));
      expect(row.querySelector(".video-row-list")).toHaveClass("is-wide");
      expect(within(row).getByText("S01E02 · 50:00 left")).toBeInTheDocument();
    } finally {
      fetchSpy.mockRestore();
      resetVideoAvailable();
    }
  });

  it("keeps its rows when the banner cannot be read", async () => {
    mockApi.mockImplementation((async (path: string) => {
      if (path === "/video/api/continue") return { items: [] };
      const rows = rowsAnswer(path, [{ id: "m1", title: "The General", year: 1926 }], []);
      if (rows) return rows;
      throw new Error("The video app did not answer.");
    }) as never);
    renderSignedIn(<VideoHomePage />);
    expect(await screen.findByRole("link", { name: /The General/ })).toHaveAttribute("href", "/movies/m1");
    expect(screen.queryByRole("region", { name: "The General" })).toBeNull();
  });
});

describe("choosing a backdrop", () => {
  it("lists TMDB's backdrops, rings the one in use, and saves another, which can go back to the votes", async () => {
    const matched = { ...movie, tmdbMatch: { id: "961", state: "matched", locked: false, error: null } };
    let chosen: string | null = null;
    mockApi.mockImplementation((async (path: string, init?: RequestInit) => {
      if (path === "/video/api/admin/metadata/items/m1/backdrops") {
        return {
          backdrops: [
            { path: "/smoke.jpg", preview: "/video/api/admin/metadata/image/smoke.jpg?wide", language: null, width: 1920, height: 1080, votes: 5.1 },
            { path: "/portrait.jpg", preview: "/video/api/admin/metadata/image/portrait.jpg?wide", language: null, width: 1920, height: 1080, votes: 4.9 }
          ],
          current: chosen ?? "/smoke.jpg",
          chosen: chosen !== null
        };
      }
      if (path === "/video/api/admin/metadata/items/m1/backdrop" && init?.method === "PUT") {
        chosen = (JSON.parse(String(init.body)) as { path: string | null }).path;
        return { movie: matched };
      }
      throw new Error(`unexpected ${path}`);
    }) as never);
    const onMatched = vi.fn();
    renderSignedIn(<BackdropChooser kind="movies" title={matched as never} onChosen={onMatched} />);
    await userEvent.click(screen.getByRole("button", { name: "Choose another" }));
    const pictures = await screen.findAllByRole("button", { name: /words on it/ });
    expect(pictures[0]).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(pictures[1]);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /words on it/ })[1]).toHaveAttribute("aria-pressed", "true"));
    expect(onMatched).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Pick automatically again" }));
    await waitFor(() => expect(chosen).toBeNull());
  });
});

describe("a show's seasons", () => {
  const episode = (id: string, number: number) => ({ id, season: 0, episode: number, title: `Episode ${id}`, plot: null, aired: null, direct: "yes", progress: null });
  const show = {
    id: "s1", libraryId: "lib_tv", title: "Counterpart", originalTitle: null, year: 2017, plot: null, premiered: null, status: null, genres: ["Drama"], imdbId: null, tmdbId: null, source: "nfo",
    seasons: [{ number: 1, episodes: [episode("e1", 1)] }, { number: 2, episodes: [episode("e2", 1), episode("e3", 2)] }],
    nextUp: { id: "e2", season: 2, episode: 1, title: "Episode e2", position: 0 }
  };

  it("opens on the season this person is up to, and shows one at a time", async () => {
    mockApi.mockResolvedValue(show as never);
    renderSignedIn(<VideoTitlePage kind="shows" id="s1" />);
    expect(await screen.findByRole("tab", { name: "Season 2" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("link", { name: "Play Episode e3" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Play Episode e1" })).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "Season 1" }));
    expect(screen.getByRole("link", { name: "Play Episode e1" })).toHaveAttribute("href", "/watch/e1");
    expect(screen.queryByRole("link", { name: "Play Episode e3" })).toBeNull();
  });
});

describe("one page for films and shows", () => {
  const libraries = { libraries: [{ id: "lib_tv", name: "TV", kind: "shows" }, { id: "lib_kids", name: "Kids", kind: "shows" }, { id: "lib_mov", name: "Films", kind: "movies" }] };
  const titles = {
    items: [{ kind: "shows", ...shows.items[0] }, { kind: "movies", ...movie, seasons: undefined }],
    total: 2,
    page: 1,
    pageSize: 200
  };
  const answer = (over: Record<string, unknown> = {}) => mockApi.mockImplementation((async (path: string) => {
    if (path in over) return over[path];
    if (path === "/api/video/home") return homeLayout();
    if (path === "/video/api/libraries") return libraries;
    if (path.startsWith("/video/api/genres")) return { genres: ["Comedy", "Драма"] };
    if (path.startsWith("/video/api/titles?")) return titles;
    if (path === "/video/api/continue") return { items: [] };
    if (path.startsWith("/video/api/movies?")) return { items: [{ ...movie, seasons: undefined }], total: 1, page: 1, pageSize: 30 };
    if (path.startsWith("/video/api/shows?")) return shows;
    if (path.startsWith("/video/api/sets?")) return { items: [], total: 0, page: 1, pageSize: 200 };
    if (path === "/video/api/movies/m1") return movie;
    throw new Error(`unexpected ${path}`);
  }) as never);

  it("narrows its rows to shows with the switch, and keeps it in the address", async () => {
    answer();
    renderSignedIn(<VideoHomePage />);
    expect(await screen.findByRole("heading", { name: "Recently added movies" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Shows" }));
    expect(screen.queryByRole("heading", { name: "Recently added movies" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Recently added shows" })).toBeInTheDocument();
    expect(window.location.search).toBe("?kind=shows");
  });

  it("lists films and shows together in the grid, each linking to its own page", async () => {
    at("/videos?view=grid");
    answer();
    renderSignedIn(<VideoHomePage />);
    expect(await screen.findByText("2017 · 2 seasons · 20 episodes")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Counterpart/ })).toHaveAttribute("href", "/shows/s1");
    expect(screen.getByRole("link", { name: /The General/ })).toHaveAttribute("href", "/movies/m1");
    expect(screen.getByText("2 titles")).toBeInTheDocument();
    expect(mockApi).toHaveBeenCalledWith("/video/api/titles?pageSize=200&sort=title");
  });

  it("opens on the kind and genres in the address, and asks the engine for just those", async () => {
    at("/videos?kind=shows&genres=Comedy,%D0%94%D1%80%D0%B0%D0%BC%D0%B0");
    answer();
    renderSignedIn(<VideoHomePage />);
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith(`/video/api/titles?${new URLSearchParams({ pageSize: "200", sort: "title", kind: "shows", genres: "Comedy,Драма" })}`));
    // A filter shows the grid on its own, with a chip to take it off.
    fireEvent.click(await screen.findByRole("button", { name: "Comedy" }));
    expect(window.location.search).toBe(`?kind=shows&genres=${encodeURIComponent("Драма")}`);
  });

  it("searches the whole catalog when the search settles", async () => {
    answer();
    renderSignedIn(<VideoHomePage />);
    await userEvent.type(await screen.findByPlaceholderText("Search movies and shows"), "rad");
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/video/api/titles?pageSize=200&q=rad&sort=title"));
  });

  it("finds people too, above the titles, each linking to their page", async () => {
    answer({ "/video/api/people?q=rad&limit=12": { people: [{ id: "t8", name: "Rad Actor", photo: "/video/api/people/t8/photo?v=1", titles: 3 }] } });
    renderSignedIn(<VideoHomePage />);
    await userEvent.type(await screen.findByPlaceholderText("Search movies and shows"), "rad");
    const person = await screen.findByRole("link", { name: /Rad Actor/ });
    expect(person).toHaveAttribute("href", "/videos/people/t8");
    expect(person).toHaveTextContent("3 films and shows");
    expect(screen.getByRole("heading", { name: "People" })).toBeInTheDocument();
  });

  it("says plainly when the engine cannot answer", async () => {
    at("/videos?view=grid");
    answer({ "/video/api/libraries": { libraries: [] } });
    mockApi.mockImplementation((async (path: string) => {
      if (path === "/video/api/libraries") return { libraries: [] };
      throw new Error("The video app did not answer.");
    }) as never);
    renderSignedIn(<VideoHomePage />);
    expect(await screen.findByText("Video is not available right now")).toBeInTheDocument();
  });

  it("sends the old Movies and Shows addresses to the same view on the one page", async () => {
    at("/movies?view=sets");
    render(<VideoBrowseRedirect kind="movies" />);
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe("/videos?kind=movies&view=sets"));
    at("/shows");
    render(<VideoBrowseRedirect kind="shows" />);
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe("/videos?kind=shows&view=grid"));
  });
});

describe("the household's rows", () => {
  const libraries = { libraries: [{ id: "lib_mov", name: "Films", kind: "movies" }, { id: "lib_kids", name: "Kids", kind: "movies" }] };
  const answer = (layout: object) => mockApi.mockImplementation((async (path: string, options?: RequestInit) => {
    if (path === "/api/video/home" && options?.method === "PUT") {
      const body = JSON.parse(String(options.body));
      return { rows: body.rows, custom: true, mine: body.scope === "mine", editable: true };
    }
    if (path === "/api/video/home" && options?.method === "DELETE") return homeLayout({ editable: true });
    if (path === "/api/video/home") return layout;
    if (path === "/video/api/libraries") return libraries;
    if (path.startsWith("/video/api/genres")) return { genres: ["Comedy", "Drama"] };
    if (path === "/video/api/continue") return { items: [] };
    if (path.startsWith("/video/api/sets")) return { items: [], total: 0, page: 1, pageSize: 200 };
    if (path.startsWith("/video/api/titles?")) return { items: [{ kind: "movies", ...movie }], total: 1, page: 1, pageSize: 30 };
    if (path === "/video/api/movies/m1") return movie;
    throw new Error(`unexpected ${path}`);
  }) as never);
  const saved = () => {
    const put = mockApi.mock.calls.find(([path, options]) => path === "/api/video/home" && (options as RequestInit | undefined)?.method === "PUT");
    return put ? JSON.parse(String((put[1] as RequestInit).body)).rows : null;
  };

  it("draws each row the household chose, asking the engine what the row asks", async () => {
    answer(homeLayout({ rows: [{ id: "c", type: "titles", kind: "all", libraries: ["lib_kids"], genres: ["Comedy"], sort: "title", title: "Funny cartoons" }], custom: true }));
    renderSignedIn(<VideoHomePage />);
    expect(await screen.findByRole("heading", { name: "Funny cartoons" })).toBeInTheDocument();
    expect(mockApi).toHaveBeenCalledWith(`/video/api/titles?${new URLSearchParams({ pageSize: "30", sort: "title", libraries: "lib_kids", genres: "Comedy" })}`);
  });

  it("lets a member make the rows their own, and only their own", async () => {
    answer(homeLayout());
    renderSignedIn(<VideoHomePage />);
    await userEvent.click(await screen.findByRole("button", { name: "Customize" }));
    const dialog = await screen.findByRole("dialog", { name: "Video page rows" });
    expect(within(dialog).queryByRole("tab", { name: "Everyone" })).toBeNull();
    expect(within(dialog).getByText(/Your own video page/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Hide Sets" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save rows" }));
    await waitFor(() => expect(saved()).not.toBeNull());
    const put = mockApi.mock.calls.find(([path, options]) => path === "/api/video/home" && (options as RequestInit | undefined)?.method === "PUT")!;
    expect(JSON.parse(String((put[1] as RequestInit).body)).scope).toBe("mine");
  });

  it("lets an admin with rows of their own still change everyone's", async () => {
    answer(homeLayout({ editable: true, mine: true, rows: [{ id: "c", type: "continue" }] }));
    renderSignedIn(<VideoHomePage />);
    await userEvent.click(await screen.findByRole("button", { name: "Customize" }));
    const dialog = await screen.findByRole("dialog", { name: "Video page rows" });
    expect(within(dialog).getByRole("tab", { name: "Just me" })).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).getByRole("button", { name: "Use the household's rows" })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("tab", { name: "Everyone" }));
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/api/video/home?scope=everyone"));
  });

  it("names a row from what it asks for when nobody named it", async () => {
    answer(homeLayout({ rows: [{ id: "g", type: "titles", kind: "movies", libraries: [], genres: ["Drama"], sort: "added" }, { id: "x", type: "sets", hidden: true }], custom: true }));
    renderSignedIn(<VideoHomePage />);
    expect(await screen.findByRole("heading", { name: "Drama · Movies" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sets" })).toBeNull();
  });

  it("lets an admin hide, move and add rows, and saves them for everyone", async () => {
    answer(homeLayout({ editable: true }));
    renderSignedIn(<VideoHomePage />);
    await userEvent.click(await screen.findByRole("button", { name: "Customize" }));
    const dialog = await screen.findByRole("dialog", { name: "Video page rows" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Hide Sets" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Move Recently added shows up" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Add row" }));
    await userEvent.click(await within(dialog).findByRole("checkbox", { name: "Comedy" }));
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Kids" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Add row" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save rows" }));
    await waitFor(() => expect(saved()).not.toBeNull());
    const rows = saved() as { id: string; type: string; hidden?: boolean; genres?: string[]; libraries?: string[] }[];
    expect(rows.map((row) => row.id).slice(0, 4)).toEqual(["continue", "new-shows", "new-movies", "sets"]);
    expect(rows[3].hidden).toBe(true);
    expect(rows[4]).toMatchObject({ type: "titles", kind: "all", genres: ["Comedy"], libraries: ["lib_kids"], sort: "added" });
    expect(await screen.findByRole("heading", { name: "Comedy" })).toBeInTheDocument();
  });

  it("saves what the grid shows as a row at the end of the page", async () => {
    at("/videos?kind=movies&genres=Comedy&sort=year");
    answer(homeLayout({ editable: true }));
    renderSignedIn(<VideoHomePage />);
    await userEvent.click(await screen.findByRole("button", { name: "Save as row" }));
    await waitFor(() => expect(saved()).not.toBeNull());
    expect(saved().at(-1)).toMatchObject({ type: "titles", kind: "movies", genres: ["Comedy"], libraries: [], sort: "year" });
    expect(await screen.findByText('"Comedy · Movies" is now a row on the video page.')).toBeInTheDocument();
  });
});

describe("My list and Collection rows", () => {
  const items = [
    { kind: "shows", id: "s1", title: "Counterpart", year: 2017, poster: null },
    { kind: "movies", id: "m1", title: "The General", year: 1926, poster: null }
  ];

  it("puts a title on My list and takes it off again", async () => {
    let inList = false;
    mockApi.mockImplementation((async (path: string, options?: RequestInit) => {
      if (path !== "/api/video/my-list/movies/m1") throw new Error(`unexpected ${path}`);
      if (options?.method === "PUT") inList = true;
      if (options?.method === "DELETE") inList = false;
      return { inList };
    }) as never);
    render(<MyListButton kind="movies" id="m1" />);
    await userEvent.click(await screen.findByRole("button", { name: "My list" }));
    expect(await screen.findByRole("button", { name: "On my list" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "On my list" }));
    expect(await screen.findByRole("button", { name: "My list" })).toHaveAttribute("aria-pressed", "false");
  });

  it("lists My list as a page, each title linking to its own", async () => {
    mockApi.mockImplementation((async (path: string) => (path === "/api/video/my-list" ? { items } : (() => { throw new Error(path); })())) as never);
    renderSignedIn(<VideoMyListPage />);
    expect(await screen.findByRole("link", { name: /Counterpart/ })).toHaveAttribute("href", "/shows/s1");
    expect(screen.getByText("2 titles")).toBeInTheDocument();
  });

  it("draws a Collection row under the collection's name, and My list, both narrowed by the switch", async () => {
    mockApi.mockImplementation((async (path: string) => {
      if (path === "/api/video/home") return homeLayout({ rows: [{ id: "c", type: "collection", collectionId: "col1" }, { id: "l", type: "mylist" }], custom: true });
      if (path === "/api/video/home/collections/col1") return { name: "Family movie night", items };
      if (path === "/api/video/my-list") return { items: [items[1]] };
      if (path.startsWith("/video/api/titles")) return { items: [{ kind: "movies", ...movie }], total: 1, page: 1, pageSize: 1 };
      if (path === "/video/api/continue") return { items: [] };
      if (path === "/video/api/movies/m1") return movie;
      throw new Error(`unexpected ${path}`);
    }) as never);
    renderSignedIn(<VideoHomePage />);
    const row = (await screen.findByRole("heading", { name: "Family movie night" })).closest("section")!;
    await waitFor(() => expect(within(row).getAllByRole("link")).toHaveLength(2));
    expect(screen.getByRole("heading", { name: "My list" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Shows" }));
    await waitFor(() => expect(within(screen.getByRole("heading", { name: "Family movie night" }).closest("section")!).getAllByRole("link")).toHaveLength(1));
    // My list has no show on it: the row goes.
    expect(screen.queryByRole("heading", { name: "My list" })).toBeNull();
  });
});

describe("a show's page", () => {
  it("shows its seasons and episodes", async () => {
    mockApi.mockResolvedValue({
      id: "s2", libraryId: "lib_tv", title: "Радар", originalTitle: null, year: 2026, plot: "1988 год.", premiered: null, status: null,
      genres: ["Драма"], imdbId: "tt33022834", tmdbId: null, source: "nfo",
      seasons: [{ number: 1, episodes: [
        { id: "e1", episode: 1, title: "Серия 1", plot: null, aired: "2026-04-24", runtimeMinutes: null, direct: "maybe",
          progress: { position: 2400, duration: 2400, watched: true, updatedAt: "2026-10-26T10:00:00.000Z" } },
        { id: "e2", episode: 2, title: null, plot: null, aired: null, runtimeMinutes: null, direct: "maybe",
          progress: { position: 754, duration: 2400, watched: false, updatedAt: "2026-10-26T11:00:00.000Z" } }
      ] }],
      nextUp: { id: "e2", season: 1, episode: 2, title: null, position: 754 }
    });
    renderSignedIn(<VideoTitlePage kind="shows" id="s2" />);
    expect(await screen.findByRole("heading", { name: "Радар" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Season 1" })).toBeInTheDocument();
    expect(screen.getByText("Серия 1")).toBeInTheDocument();
    // An episode the engine has no title for is named by its number.
    expect(screen.getByText("Episode 2")).toBeInTheDocument();
    expect(mockApi).toHaveBeenCalledWith("/video/api/shows/s2");
    // Play picks up where this person stopped; a watched episode is marked.
    expect(screen.getByRole("link", { name: "Resume S01E02 from 12:34" })).toHaveAttribute("href", "/watch/e2");
    expect(screen.getByLabelText("Watched")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Play Серия 1" })).toHaveAttribute("href", "/watch/e1");
  });

  it("wears the poster and backdrop, and lets an admin fix its TMDB match", async () => {
    const movie = {
      id: "m1", libraryId: "lib_mov", title: "Loose Film", originalTitle: null, year: 1999, plot: null, genres: [], runtimeMinutes: null,
      imdbId: null, tmdbId: null, source: "folder", direct: "yes", progress: null,
      poster: "/video/api/art/m1/poster?v=1", backdrop: "/video/api/art/m1/backdrop?v=1", rating: null,
      tmdbMatch: { id: null, state: "unmatched", locked: false, error: null }
    };
    const fixed = { ...movie, title: "Loose Film", plot: "The one.", tmdbId: "404", rating: 6, tmdbMatch: { id: "404", state: "matched", locked: true, error: null } };
    mockApi.mockImplementation((async (path: string, init?: RequestInit) => {
      if (path === "/video/api/movies/m1") return movie;
      if (path.startsWith("/video/api/admin/metadata/search?")) {
        return { results: [{ tmdbId: "404", title: "The Right Film", originalTitle: null, year: 1999, overview: "The one.", poster: "/video/api/admin/metadata/image/p404.jpg" }] };
      }
      if (path === "/video/api/admin/metadata/items/m1" && init?.method === "PUT") return { movie: fixed };
      if (path === "/video/api/admin/titles/m1/edit" && init?.method === "PUT") return { movie: { ...fixed, plot: "The one." } };
      if (path === "/video/api/admin/titles/m1/edit") return editState(movie);
      if (path === "/video/api/admin/genres") return { genres: [], words: [] };
      if (path.startsWith("/video/api/admin/metadata/details?")) {
        return { tmdbId: "404", kind: "movie", title: "The Right Film", originalTitle: null, year: 1999, plot: "The one.", genres: [], poster: null };
      }
      throw new Error(`unexpected ${path}`);
    }) as never);
    renderSignedIn(<VideoTitlePage kind="movies" id="m1" />, { user: { id: "a1", role: "admin" } as never });
    expect(await screen.findByRole("heading", { name: "Loose Film" })).toBeInTheDocument();
    expect(document.querySelector(".video-title-cover img")).toHaveAttribute("src", "/video/api/art/m1/poster?v=1");
    expect(document.querySelector(".video-title-backdrop img")).toHaveAttribute("src", "/video/api/art/m1/backdrop?v=1");

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.click(await screen.findByRole("tab", { name: "Lookup" }));
    await userEvent.click(screen.getByRole("button", { name: "Search TMDB" }));
    expect(mockApi).toHaveBeenCalledWith("/video/api/admin/metadata/search?kind=movie&q=Loose+Film&language=en&year=1999");
    await userEvent.click(await screen.findByRole("button", { name: /The Right Film \(1999\)/ }));
    // TMDB's description is ticked to begin with, since the film has none; its title is not.
    expect(await screen.findByRole("checkbox", { name: "Take the Description from TMDB" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Take the Title from TMDB" })).not.toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Use this title" }));
    expect(screen.getByText(/Save matches this title to "The Right Film" on TMDB \(404\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mockApi).toHaveBeenCalledWith("/video/api/admin/metadata/items/m1", expect.objectContaining({ method: "PUT", body: JSON.stringify({ tmdbId: "404" }) }));
    expect(mockApi).toHaveBeenCalledWith("/video/api/admin/titles/m1/edit", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ title: null, originalTitle: null, sortTitle: null, year: null, plot: "The one.", genres: null })
    }));
    expect(await screen.findByText("The one.")).toBeInTheDocument();
    expect(screen.getByText(/★ 6\.0/)).toBeInTheDocument();
  });

  it("says when a Fix match candidate is a TV show on TMDB, and sends that kind with the choice", async () => {
    const movie = {
      id: "m1", libraryId: "lib_mov", title: "Concert Peter's Pop Show", originalTitle: null, year: 1985, plot: null, genres: [], runtimeMinutes: 90,
      imdbId: null, tmdbId: null, source: "folder", direct: "yes", progress: null, poster: null, backdrop: null, rating: null,
      tmdbMatch: { id: null, state: "unmatched", locked: false, error: null }
    };
    const fixed = { ...movie, plot: "Pop acts of the year.", tmdbId: "505", tmdbMatch: { id: "505", kind: "tv", state: "matched", locked: true, error: null } };
    mockApi.mockImplementation((async (path: string, init?: RequestInit) => {
      if (path === "/video/api/movies/m1") return movie;
      if (path.startsWith("/video/api/admin/metadata/search?")) {
        return { results: [
          { tmdbId: "505", kind: "movie", title: "Pop Show, the film", originalTitle: null, year: 1985, overview: null, poster: null },
          { tmdbId: "505", kind: "tv", title: "Peter's Pop Show", originalTitle: null, year: 1985, overview: null, poster: null }
        ] };
      }
      if (path === "/video/api/admin/metadata/items/m1" && init?.method === "PUT") return { movie: fixed };
      if (path === "/video/api/admin/titles/m1/edit") return editState(movie);
      if (path === "/video/api/admin/genres") return { genres: [], words: [] };
      if (path.startsWith("/video/api/admin/metadata/details?kind=tv&id=505")) {
        return { tmdbId: "505", kind: "tv", title: "Peter's Pop Show", originalTitle: null, year: 1985, plot: null, genres: [], poster: null };
      }
      throw new Error(`unexpected ${path}`);
    }) as never);
    renderSignedIn(<VideoTitlePage kind="movies" id="m1" />, { user: { id: "a1", role: "admin" } as never });
    await screen.findByRole("heading", { name: "Concert Peter's Pop Show" });
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.click(await screen.findByRole("tab", { name: "Lookup" }));
    await userEvent.click(screen.getByRole("button", { name: "Search TMDB" }));
    // Both have TMDB id 505: a film and a show are different counts there, so both are offered and the show says so.
    const show = await screen.findByRole("button", { name: /Peter's Pop Show \(1985\)/ });
    expect(show).toHaveTextContent("A TV show on TMDB");
    expect(screen.getByRole("button", { name: /Pop Show, the film/ })).not.toHaveTextContent("on TMDB");
    await userEvent.click(show);
    await userEvent.click(await screen.findByRole("button", { name: "Use this title" }));
    // Nothing ticked: only the match is saved, with where on TMDB it is.
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mockApi).toHaveBeenCalledWith("/video/api/admin/metadata/items/m1", expect.objectContaining({ method: "PUT", body: JSON.stringify({ tmdbId: "505", tmdbKind: "tv" }) }));
    expect(mockApi).not.toHaveBeenCalledWith("/video/api/admin/titles/m1/edit", expect.objectContaining({ method: "PUT" }));
    expect(await screen.findByText("Pop acts of the year.")).toBeInTheDocument();
  });

  it("names a miniseries' parts as TMDB's episodes, and plain parts by their number", async () => {
    const part = (n: number, over: Record<string, unknown> = {}) => ({ id: n === 1 ? "m1" : `p${n}`, part: n, direct: "yes", progress: null, ...over });
    mockApi.mockResolvedValue({
      id: "m1", libraryId: "lib_mov", title: "Д'Артаньян и три мушкетёра", originalTitle: null, year: 1979, plot: null, genres: [], runtimeMinutes: null,
      imdbId: null, tmdbId: "76829", source: "folder", direct: "yes", progress: null,
      parts: [
        part(1, { title: "Атос, Портос, Арамис и Д'Артаньян", plot: "Гасконец едет в Париж.", aired: "1979-12-25", still: "/video/api/art/m1-part1/still?v=1" }),
        part(2)
      ]
    });
    renderSignedIn(<VideoTitlePage kind="movies" id="m1" />);
    const first = await screen.findByRole("link", { name: "Play Атос, Портос, Арамис и Д'Артаньян" });
    expect(first.querySelector("img")).toHaveAttribute("src", "/video/api/art/m1-part1/still?v=1");
    expect(screen.getByText("Гасконец едет в Париж.")).toBeInTheDocument();
    expect(screen.getByText(/^Part 1 · /)).toBeInTheDocument();
    // A part TMDB says nothing of keeps its number.
    expect(screen.getByRole("link", { name: "Play Part 2" })).toHaveAttribute("href", "/watch/p2");
  });

  it("puts a film into a set by hand from the Edit dialog's Set tab", async () => {
    const film = {
      id: "m1", libraryId: "lib_mov", title: "Loose Film", originalTitle: null, year: 1999, plot: null, genres: [], runtimeMinutes: null,
      imdbId: null, tmdbId: null, source: "folder", direct: "yes", progress: null
    };
    mockApi.mockImplementation((async (path: string, init?: RequestInit) => {
      if (path === "/video/api/movies/m1") return film;
      if (path === "/video/api/admin/titles/m1/edit" && init?.method === "PUT") return { movie: film };
      if (path === "/video/api/admin/titles/m1/edit") return { ...editState(film), set: { edited: null, automatic: "Old Set" } };
      if (path === "/video/api/admin/genres") return { genres: [], words: [] };
      if (path === "/video/api/admin/sets/names") return { sets: [{ id: "s1", name: "Our Films", films: 2 }] };
      throw new Error(`unexpected ${path}`);
    }) as never);
    renderSignedIn(<VideoTitlePage kind="movies" id="m1" />, { user: { id: "a1", role: "admin" } as never });
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await userEvent.click(await screen.findByRole("tab", { name: "Set" }));
    expect(screen.getByText("Found: Old Set")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: /In this set/ }));
    await userEvent.type(screen.getByRole("combobox", { name: "Set" }), "Our Films");
    await userEvent.type(screen.getByRole("textbox", { name: "Place in the set" }), "2");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mockApi).toHaveBeenCalledWith("/video/api/admin/titles/m1/edit", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ title: null, originalTitle: null, sortTitle: null, year: null, plot: null, genres: null, set: { mode: "named", name: "Our Films", order: 2 } })
    }));
  });

  it("offers Edit to admins only", async () => {
    mockApi.mockResolvedValue({
      id: "m1", libraryId: "lib_mov", title: "Loose Film", originalTitle: null, year: 1999, plot: null, genres: [], runtimeMinutes: null,
      imdbId: null, tmdbId: null, source: "folder", direct: "yes", progress: null
    });
    renderSignedIn(<VideoTitlePage kind="movies" id="m1" />);
    expect(await screen.findByRole("heading", { name: "Loose Film" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    // An engine older than 0.6.0 sends no poster: the kind's placeholder art stands in.
    expect(document.querySelector(".video-title-cover img")).toHaveAttribute("src", "/Assets/covers/movie.svg");
  });

  it("says so when the title is gone or not this person's", async () => {
    mockApi.mockRejectedValue(new Error("No such show"));
    renderSignedIn(<VideoTitlePage kind="shows" id="gone" />);
    expect(await screen.findByText("This is not here any more, or not for you.")).toBeInTheDocument();
  });
});

describe("the player", () => {
  const playInfo = {
    id: "e2", type: "episode", title: "Birds of a Feather", show: { id: "s1", title: "Counterpart" }, season: 1, episode: 2,
    runtimeMinutes: null, available: true, sizeBytes: 1000,
    playback: { mode: "direct", reasons: [], url: "/video/api/stream/e2", duration: 2400 }, progress: null, resumeAt: 754,
    next: { id: "e3", season: 1, episode: 3, title: "The Lost Art of Diplomacy" }
  };

  it("plays the engine's stream, titled by show and episode, with the next one offered", async () => {
    mockApi.mockResolvedValue(playInfo);
    renderSignedIn(<VideoPlayerPage id="e2" />);
    expect(await screen.findByRole("heading", { name: "Counterpart" })).toBeInTheDocument();
    expect(screen.getByText("S01E02 · Birds of a Feather")).toBeInTheDocument();
    expect(document.querySelector("video")).toHaveAttribute("src", "/video/api/stream/e2");
    expect(screen.getByRole("link", { name: /Up next: S01E03/ })).toHaveAttribute("href", "/watch/e3");
    expect(mockApi).toHaveBeenCalledWith("/video/api/play/e2");
  });

  it("plays a file the engine converts through hls.js, from where the person stopped", async () => {
    const hls = { mode: "remux", reasons: ["container", "audio"], url: "/video/api/hls/e2/index.m3u8", duration: 2400 };
    mockApi.mockResolvedValue({ ...playInfo, playback: hls });
    const view = renderSignedIn(<VideoPlayerPage id="e2" />);
    await waitFor(() => expect(hlsCalls.source).toBe("/video/api/hls/e2/index.m3u8"));
    const element = document.querySelector("video");
    expect(element).not.toHaveAttribute("src");
    expect(hlsCalls.attached).toBe(element);
    expect(hlsCalls.config).toMatchObject({ startPosition: 754 });
    expect(screen.getByText("Getting it ready…")).toBeInTheDocument();

    // Leaving stops the conversion on the engine.
    const fetchSpy = vi.spyOn(window, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    view.unmount();
    expect(hlsCalls.destroyed).toBe(1);
    expect(fetchSpy).toHaveBeenCalledWith("/video/api/hls/e2", expect.objectContaining({ method: "DELETE", keepalive: true }));
    fetchSpy.mockRestore();
  });

  it("stops the conversion when the tab closes, and hangs up before it says so", async () => {
    const hls = { mode: "remux", reasons: ["container", "audio"], url: "/video/api/hls/e2/index.m3u8", duration: 2400 };
    mockApi.mockResolvedValue({ ...playInfo, playback: hls });
    // Left by the test before; only this film's player may answer the wait below.
    hlsCalls.source = "";
    const view = renderSignedIn(<VideoPlayerPage id="e2" />);
    await waitFor(() => expect(hlsCalls.source).toBe("/video/api/hls/e2/index.m3u8"));

    const stops = () => fetchSpy.mock.calls.filter(([, init]) => init?.method === "DELETE").length;
    const destroyedBefore = hlsCalls.destroyed;
    let destroyedAtStop = -1;
    const fetchSpy = vi.spyOn(window, "fetch").mockImplementation((_url, init) => {
      if (init?.method === "DELETE") destroyedAtStop = hlsCalls.destroyed;
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    window.dispatchEvent(new Event("pagehide"));
    expect(stops()).toBe(1);

    view.unmount();
    expect(destroyedAtStop).toBe(destroyedBefore + 1);
    fetchSpy.mockRestore();
  });

  describe("sound tracks", () => {
    const english = { index: 1, codec: "ac3", channels: 6, language: "eng", title: null, default: true, selected: true };
    const russian = { index: 2, codec: "aac", channels: 2, language: "rus", title: "Дубляж", default: false, selected: false };
    const hlsFor = (track: number) => ({ mode: "remux", reasons: ["container", "audio"], url: `/video/api/hls/e2/t${track}/index.m3u8`, duration: 2400 });
    const answer = (path: string) => (path.endsWith("?audio=2")
      ? { ...playInfo, playback: hlsFor(2), audioTracks: [{ ...english, selected: false }, { ...russian, selected: true }] }
      : { ...playInfo, playback: hlsFor(1), audioTracks: [english, russian] });

    beforeEach(() => {
      window.localStorage.removeItem("isputnik.video.audioLanguage");
      hlsCalls.source = "";
    });

    it("names each track by language, title and channels, and switches to the one chosen from where the film is", async () => {
      mockApi.mockImplementation((async (path: string) => answer(path)) as never);
      renderSignedIn(<VideoPlayerPage id="e2" />);
      await waitFor(() => expect(hlsCalls.source).toBe("/video/api/hls/e2/t1/index.m3u8"));

      await userEvent.click(screen.getByRole("button", { name: "Settings" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Sound: English · 5.1" }));
      await userEvent.click(screen.getByRole("menuitemradio", { name: /Russian · Дубляж · Stereo/ }));
      expect(mockApi).toHaveBeenCalledWith("/video/api/play/e2?audio=2");
      await waitFor(() => expect(hlsCalls.source).toBe("/video/api/hls/e2/t2/index.m3u8"));
      await userEvent.click(screen.getByRole("button", { name: "Settings" }));
      expect(screen.getByRole("menuitem", { name: "Sound: Russian · Дубляж · Stereo" })).toBeInTheDocument();
      // The next film starts in Russian.
      expect(window.localStorage.getItem("isputnik.video.audioLanguage")).toBe("rus");
    });

    it("starts in the language chosen last time", async () => {
      window.localStorage.setItem("isputnik.video.audioLanguage", "rus");
      mockApi.mockImplementation((async (path: string) => answer(path)) as never);
      renderSignedIn(<VideoPlayerPage id="e2" />);
      await waitFor(() => expect(hlsCalls.source).toBe("/video/api/hls/e2/t2/index.m3u8"));
      expect(hlsCalls.config).toMatchObject({ startPosition: 754 });
    });

    it("shows no menu for a film with one sound track", async () => {
      mockApi.mockResolvedValue({ ...playInfo, audioTracks: [english] });
      renderSignedIn(<VideoPlayerPage id="e2" />);
      expect(await screen.findByRole("heading", { name: "Counterpart" })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Settings" }));
      expect(screen.getByRole("menuitem", { name: "Speed: Normal" })).toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: /^Sound/ })).not.toBeInTheDocument();
    });
  });

  describe("quality (engine 0.31+)", () => {
    const hlsAt = (rung: number | null, network: string, allowed: (number | null)[]) => ({
      mode: rung ? "transcode" : "remux", reasons: rung ? ["container", "size"] : ["container"],
      url: `/video/api/hls/e2/t1${rung ? `q${rung}` : ""}/index.m3u8`, duration: 2400,
      quality: { current: rung, allowed, network }
    });
    const atHome = (path: string) => {
      const asked = /quality=(\w+)/.exec(path)?.[1];
      return { ...playInfo, playback: hlsAt(asked && asked !== "original" ? Number(asked) : null, "home", [null, 1080, 720, 480]) };
    };

    beforeEach(() => {
      window.localStorage.removeItem("isputnik.video.quality.home");
      window.localStorage.removeItem("isputnik.video.quality.away");
      hlsCalls.source = "";
    });

    it("offers the rungs the engine allows, and switches to the one chosen from where the film is", async () => {
      mockApi.mockImplementation((async (path: string) => atHome(path)) as never);
      renderSignedIn(<VideoPlayerPage id="e2" />);
      await waitFor(() => expect(hlsCalls.source).toBe("/video/api/hls/e2/t1/index.m3u8"));

      await userEvent.click(screen.getByRole("button", { name: "Settings" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Quality: Original" }));
      expect(screen.getAllByRole("menuitemradio").map((option) => option.textContent)).toEqual(["Original", "1080p", "720p", "480p"]);
      await userEvent.click(screen.getByRole("menuitemradio", { name: "720p" }));
      expect(mockApi).toHaveBeenCalledWith("/video/api/play/e2?quality=720");
      await waitFor(() => expect(hlsCalls.source).toBe("/video/api/hls/e2/t1q720/index.m3u8"));
      await userEvent.click(screen.getByRole("button", { name: "Settings" }));
      expect(screen.getByRole("menuitem", { name: "Quality: 720p" })).toBeInTheDocument();
      // Remembered for the next film at home, apart from the choice away.
      expect(window.localStorage.getItem("isputnik.video.quality.home")).toBe("720");
      expect(window.localStorage.getItem("isputnik.video.quality.away")).toBeNull();
    });

    it("starts at the quality chosen last time here, when the engine allows it", async () => {
      window.localStorage.setItem("isputnik.video.quality.home", "480");
      mockApi.mockImplementation((async (path: string) => atHome(path)) as never);
      renderSignedIn(<VideoPlayerPage id="e2" />);
      await waitFor(() => expect(hlsCalls.source).toBe("/video/api/hls/e2/t1q480/index.m3u8"));
      expect(hlsCalls.config).toMatchObject({ startPosition: 754 });
    });

    it("away from home offers only what the admin's cap allows, and hides the menu under a cap of one", async () => {
      // Capped at 720p: the engine starts there and offers 720p and 480p.
      mockApi.mockResolvedValue({ ...playInfo, playback: hlsAt(720, "internet", [720, 480]) });
      const view = renderSignedIn(<VideoPlayerPage id="e2" />);
      await userEvent.click(await screen.findByRole("button", { name: "Settings" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Quality: 720p" }));
      expect(screen.getAllByRole("menuitemradio").map((option) => option.textContent)).toEqual(["720p", "480p"]);
      view.unmount();

      mockApi.mockResolvedValue({ ...playInfo, playback: hlsAt(480, "internet", [480]) });
      renderSignedIn(<VideoPlayerPage id="e2" />);
      expect(await screen.findByRole("heading", { name: "Counterpart" })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Settings" }));
      expect(screen.queryByRole("menuitem", { name: /^Quality/ })).not.toBeInTheDocument();
    });

    it("shows no menu to an engine that offers no quality", async () => {
      mockApi.mockResolvedValue(playInfo);
      renderSignedIn(<VideoPlayerPage id="e2" />);
      expect(await screen.findByRole("heading", { name: "Counterpart" })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Settings" }));
      expect(screen.queryByRole("menuitem", { name: /^Quality/ })).not.toBeInTheDocument();
    });
  });

  describe("subtitles", () => {
    const text = { id: "s3", kind: "text", codec: "subrip", language: "eng", title: null, default: false, forced: false, external: false, url: "/video/api/subtitles/e2/s3.vtt", burned: false };
    const beside = { id: "x0123456789", kind: "text", codec: "srt", language: "ru", title: "SDH", default: false, forced: false, external: true, url: "/video/api/subtitles/e2/x0123456789.vtt", burned: false };
    const image = { id: "s4", kind: "image", codec: "hdmv_pgs_subtitle", language: "fre", title: null, default: false, forced: false, external: false, url: null, burned: false };
    const burnedHls = { mode: "transcode", reasons: ["container", "subtitles"], url: "/video/api/hls/e2/t-b4/index.m3u8", duration: 2400 };
    const answer = (path: string) => (path.endsWith("?subtitle=s4")
      ? { ...playInfo, playback: burnedHls, subtitleTracks: [text, beside, { ...image, burned: true }] }
      : { ...playInfo, subtitleTracks: [text, beside, image] });

    beforeEach(() => {
      window.localStorage.removeItem("isputnik.video.subtitleLanguage");
      hlsCalls.source = "";
    });

    it("gives the browser each text track and shows none until one is chosen", async () => {
      mockApi.mockImplementation((async (path: string) => answer(path)) as never);
      renderSignedIn(<VideoPlayerPage id="e2" />);
      await userEvent.click(await screen.findByRole("button", { name: "Subtitles: Off" }));
      expect(screen.getByRole("menuitemradio", { name: "Russian · SDH" })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("menuitemradio", { name: "English" }));
      const tracks = [...document.querySelectorAll("video track")];
      expect(tracks.map((track) => track.getAttribute("src"))).toEqual(["/video/api/subtitles/e2/s3.vtt", "/video/api/subtitles/e2/x0123456789.vtt"]);
      expect(screen.getByRole("button", { name: "Subtitles: English" })).toBeInTheDocument();
      // Text needs nothing from the engine: the film plays on as it is.
      expect(mockApi).toHaveBeenCalledTimes(1);
      expect(window.localStorage.getItem("isputnik.video.subtitleLanguage")).toBe("eng");
    });

    it("has the engine burn in an image subtitle, from where the film is", async () => {
      mockApi.mockImplementation((async (path: string) => answer(path)) as never);
      renderSignedIn(<VideoPlayerPage id="e2" />);
      await userEvent.click(await screen.findByRole("button", { name: "Subtitles: Off" }));
      await userEvent.click(screen.getByRole("menuitemradio", { name: "French" }));
      expect(mockApi).toHaveBeenCalledWith("/video/api/play/e2?subtitle=s4");
      await waitFor(() => expect(hlsCalls.source).toBe("/video/api/hls/e2/t-b4/index.m3u8"));
      expect(screen.getByRole("button", { name: "Subtitles: French" })).toBeInTheDocument();
    });

    it("starts in the subtitle language chosen last time, a file's two-letter code matching a track's three", async () => {
      window.localStorage.setItem("isputnik.video.subtitleLanguage", "rus");
      mockApi.mockImplementation((async (path: string) => answer(path)) as never);
      renderSignedIn(<VideoPlayerPage id="e2" />);
      expect(await screen.findByRole("button", { name: "Subtitles: Russian · SDH" })).toBeInTheDocument();
    });
  });

  describe("its own controls", () => {
    const playing = async () => {
      mockApi.mockResolvedValue({ ...playInfo, resumeAt: 0 });
      renderSignedIn(<VideoPlayerPage id="e2" />);
      await screen.findByRole("heading", { name: "Counterpart" });
      const element = document.querySelector("video")!;
      let paused = true;
      Object.defineProperty(element, "paused", { configurable: true, get: () => paused });
      Object.defineProperty(element, "duration", { configurable: true, value: 2400 });
      Object.defineProperty(element, "currentTime", { configurable: true, writable: true, value: 100 });
      element.play = vi.fn(() => { paused = false; fireEvent.play(element); return Promise.resolve(); });
      element.pause = vi.fn(() => { paused = true; fireEvent.pause(element); });
      fireEvent.durationChange(element);
      return element;
    };

    it("leaves nothing over a playing film once the pointer rests, and brings it back with the pointer or a pause", async () => {
      const element = await playing();
      const main = document.querySelector("main")!;
      // Paused: the title and the controls stay.
      expect(main).not.toHaveClass("is-idle");
      vi.useFakeTimers();
      try {
        act(() => { void element.play(); });
        expect(main).not.toHaveClass("is-idle");
        act(() => { vi.advanceTimersByTime(3100); });
        expect(main).toHaveClass("is-idle");
        expect(document.querySelector(".video-player-bottom")).toHaveClass("is-hidden");
        fireEvent.pointerMove(main);
        expect(main).not.toHaveClass("is-idle");
        act(() => { vi.advanceTimersByTime(3100); });
        expect(main).toHaveClass("is-idle");
        act(() => { element.pause(); });
        expect(main).not.toHaveClass("is-idle");
      } finally {
        vi.useRealTimers();
      }
    });

    it("plays and pauses with its button, a click on the picture, Space and K", async () => {
      const element = await playing();
      await userEvent.click(screen.getByRole("button", { name: "Play" }));
      expect(element.play).toHaveBeenCalledTimes(1);
      await userEvent.click(screen.getByRole("button", { name: "Pause" }));
      expect(element.pause).toHaveBeenCalledTimes(1);
      await userEvent.click(element);
      expect(element.play).toHaveBeenCalledTimes(2);
      fireEvent.keyDown(document.body, { code: "Space", key: " " });
      expect(element.pause).toHaveBeenCalledTimes(2);
      fireEvent.keyDown(document.body, { code: "KeyK", key: "л" });
      expect(element.play).toHaveBeenCalledTimes(3);
    });

    it("jumps ten seconds either way with its buttons and the arrows, and goes where the line is put", async () => {
      const element = await playing();
      expect(screen.getByText("1:40 / 40:00")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Forward 10 seconds" }));
      expect(element.currentTime).toBe(110);
      await userEvent.click(screen.getByRole("button", { name: "Back 10 seconds" }));
      expect(element.currentTime).toBe(100);
      fireEvent.keyDown(document.body, { code: "ArrowRight", key: "ArrowRight" });
      expect(element.currentTime).toBe(110);
      fireEvent.keyDown(document.body, { code: "ArrowLeft", key: "ArrowLeft" });
      fireEvent.keyDown(document.body, { code: "ArrowLeft", key: "ArrowLeft" });
      expect(element.currentTime).toBe(90);
      fireEvent.change(screen.getByRole("slider", { name: "Seek" }), { target: { value: "1200" } });
      expect(element.currentTime).toBe(1200);
    });

    it("mutes with its button and M, and keeps how loud for the next film", async () => {
      window.localStorage.removeItem("isputnik.video.volume");
      window.localStorage.removeItem("isputnik.video.muted");
      const element = await playing();
      await userEvent.click(screen.getByRole("button", { name: "Mute" }));
      expect(element.muted).toBe(true);
      fireEvent.keyDown(document.body, { code: "KeyM", key: "m" });
      expect(element.muted).toBe(false);
      fireEvent.change(screen.getByRole("slider", { name: "Volume" }), { target: { value: "0.4" } });
      expect(element.volume).toBeCloseTo(0.4);
      expect(window.localStorage.getItem("isputnik.video.volume")).toBe("0.4");
      window.localStorage.removeItem("isputnik.video.volume");
      window.localStorage.removeItem("isputnik.video.muted");
    });

    it("plays faster or slower from Settings, starts over from More, and says what is being sent", async () => {
      const element = await playing();
      await userEvent.click(screen.getByRole("button", { name: "Settings" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Speed: Normal" }));
      await userEvent.click(screen.getByRole("menuitemradio", { name: "1.5×" }));
      expect(element.playbackRate).toBe(1.5);
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Start over" }));
      expect(element.currentTime).toBe(0);
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Playback information" }));
      expect(screen.getByText("The file as it is")).toBeInTheDocument();
    });
  });

  it("says how many are watching when every place to convert is taken, and tries again when asked", async () => {
    const hls = { mode: "transcode", reasons: ["video"], url: "/video/api/hls/e2/index.m3u8", duration: 2400 };
    hlsCalls.source = "";
    mockApi.mockResolvedValueOnce({ ...playInfo, playback: { ...hls, busy: { limit: 2 } } });
    renderSignedIn(<VideoPlayerPage id="e2" />);
    expect(await screen.findByText("Too many people are watching right now")).toBeInTheDocument();
    expect(screen.getByText(/2 people are already watching converted video/)).toBeInTheDocument();
    expect(document.querySelector("video")).toBeNull();
    expect(hlsCalls.source).toBe("");

    mockApi.mockResolvedValueOnce({ ...playInfo, playback: { ...hls, busy: null } });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(hlsCalls.source).toBe("/video/api/hls/e2/index.m3u8"));
    expect(screen.queryByText("Too many people are watching right now")).not.toBeInTheDocument();
  });

  it("says which film is in the way when this person is converting another already", async () => {
    const hls = { mode: "remux", reasons: ["container"], url: "/video/api/hls/e2/index.m3u8", duration: 2400 };
    hlsCalls.source = "";
    mockApi.mockResolvedValueOnce({ ...playInfo, playback: { ...hls, busy: { reason: "person", limit: 3, title: "Loud Film" } } });
    renderSignedIn(<VideoPlayerPage id="e2" />);
    expect(await screen.findByText("You are watching something else")).toBeInTheDocument();
    expect(screen.getByText(/"Loud Film" is being converted for you already/)).toBeInTheDocument();
    expect(hlsCalls.source).toBe("");
  });

  it("says why instead of a player for a file nothing can play", async () => {
    mockApi.mockResolvedValue({ ...playInfo, playback: { mode: "none", reasons: [], url: null, duration: null } });
    renderSignedIn(<VideoPlayerPage id="e2" />);
    expect(await screen.findByText(/can't convert it: ffmpeg isn't available/)).toBeInTheDocument();
    expect(document.querySelector("video")).toBeNull();
  });

  it("says the file has gone when the engine cannot find it", async () => {
    mockApi.mockResolvedValue({ ...playInfo, available: false });
    renderSignedIn(<VideoPlayerPage id="e2" />);
    expect(await screen.findByText(/no longer where the video app found it/)).toBeInTheDocument();
  });
});

describe("film sets", () => {
  const matrix = {
    id: "set1", name: "The Matrix Collection", overview: "Neo and friends.", poster: "/video/api/art/set1/poster?v=1", backdrop: null,
    films: [
      { id: "m1", title: "The Matrix", year: 1999, runtimeMinutes: 136, poster: null, progress: { position: 8000, duration: 8000, watched: true, updatedAt: "2026-10-26T10:00:00.000Z" } },
      { id: "m2", title: "The Matrix Reloaded", year: 2003, runtimeMinutes: 138, poster: null, progress: { position: 754, duration: 8000, watched: false, updatedAt: "2026-10-27T10:00:00.000Z" } },
      { id: "m3", title: "The Matrix Revolutions", year: 2003, runtimeMinutes: 129, poster: null, progress: null }
    ],
    next: { id: "m2", title: "The Matrix Reloaded", position: 754 }
  };
  const summary = { id: "set1", name: "The Matrix Collection", films: 3, watched: 1, firstYear: 1999, lastYear: 2003, poster: null };
  const page = <T,>(items: T[]) => ({ items, total: items.length, page: 1, pageSize: 200 });

  it("has its own address under /movies", () => {
    at("/movies/sets/set1");
    expect(getRoute()).toEqual({ name: "videoSet", id: "set1" });
  });

  it("switches the films grid to its Sets and keeps the choice in the address", async () => {
    const film = { kind: "movies", id: "m1", libraryId: "lib", title: "The Matrix", year: 1999, imdbId: null, genres: [], runtimeMinutes: 136 };
    mockApi.mockImplementation((async (path: string) => {
      if (path === "/video/api/libraries") return { libraries: [] };
      if (path.startsWith("/video/api/genres")) return { genres: [] };
      if (path.startsWith("/video/api/continue")) return { items: [] };
      if (path.startsWith("/video/api/sets")) return page([summary]);
      if (path === "/api/video/home") return homeLayout();
      if (path.startsWith("/video/api/titles")) return page([film]);
      if (path.startsWith("/video/api/movies") || path.startsWith("/video/api/shows")) return page([film]);
      throw new Error(`unexpected ${path}`);
    }) as never);
    at("/videos?kind=movies&view=grid");
    renderSignedIn(<VideoHomePage />);
    expect(await screen.findByText("The Matrix")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "View: Grid" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Sets" }));
    expect(await screen.findByText("The Matrix Collection")).toBeInTheDocument();
    expect(screen.getByText("3 films · 1999–2003")).toBeInTheDocument();
    expect(screen.getByText("1 set")).toBeInTheDocument();
    expect(window.location.search).toBe("?kind=movies&view=sets");
    expect(mockApi).toHaveBeenCalledWith("/video/api/sets?pageSize=200");
    // Sets are by name: no Sort while they show.
    expect(screen.queryByRole("button", { name: /^Sort:/ })).not.toBeInTheDocument();
  });

  it("offers no Sets view where there are none, as with an engine from before them", async () => {
    mockApi.mockImplementation((async (path: string) => {
      if (path === "/video/api/libraries") return { libraries: [] };
      if (path.startsWith("/video/api/genres")) return { genres: [] };
      if (path.startsWith("/video/api/continue")) return { items: [] };
      if (path.startsWith("/video/api/sets")) throw new Error("Not Found");
      if (path === "/api/video/home") return homeLayout();
      if (path.startsWith("/video/api/titles") || path.startsWith("/video/api/movies") || path.startsWith("/video/api/shows")) return page([]);
      throw new Error(`unexpected ${path}`);
    }) as never);
    at("/videos?kind=movies");
    renderSignedIn(<VideoHomePage />);
    expect(await screen.findByText("Nothing here yet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "View: Rows" }));
    expect(screen.getByRole("menuitemradio", { name: "Grid" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemradio", { name: "Sets" })).not.toBeInTheDocument();
  });

  it("plays on from the first film not yet watched, and lists the films in order", async () => {
    mockApi.mockResolvedValue(matrix);
    renderSignedIn(<VideoSetPage id="set1" />);
    expect(await screen.findByRole("heading", { name: "The Matrix Collection" })).toBeInTheDocument();
    expect(mockApi).toHaveBeenCalledWith("/video/api/sets/set1");
    expect(screen.getByText("3 films · 1999–2003 · 1 of 3 watched")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Resume The Matrix Reloaded from 12:34" })).toHaveAttribute("href", "/watch/m2");
    // A card with no picture says its name inside itself rather than under it.
    expect(screen.getAllByRole("listitem").map((item) => item.querySelector(".video-card-body strong, .video-card-blank strong")?.textContent)).toEqual(["The Matrix", "The Matrix Reloaded", "The Matrix Revolutions"]);
    expect(screen.getByRole("link", { name: /The Matrix Revolutions/ })).toHaveAttribute("href", "/movies/m3");
    expect(screen.getByRole("link", { name: "Sets" })).toHaveAttribute("href", "/videos?kind=movies&view=sets");
  });

  it("says so when every film of the set is watched", async () => {
    mockApi.mockResolvedValue({ ...matrix, next: null });
    renderSignedIn(<VideoSetPage id="set1" />);
    expect(await screen.findByText("Every film of this set is watched.")).toBeInTheDocument();
  });

  it("names the set on a film's page, over its films with this one marked", async () => {
    mockApi.mockResolvedValue({
      id: "m2", libraryId: "lib", title: "The Matrix Reloaded", originalTitle: null, year: 2003, plot: null, genres: [], runtimeMinutes: 138,
      imdbId: null, tmdbId: "604", source: "folder", direct: "yes", progress: null,
      set: { id: "set1", name: "The Matrix Collection", films: matrix.films.map(({ id, title, year, poster }) => ({ id, title, year, poster })) }
    });
    renderSignedIn(<VideoTitlePage kind="movies" id="m2" />);
    expect(await screen.findByRole("link", { name: "Part of The Matrix Collection" })).toHaveAttribute("href", "/movies/sets/set1");
    expect(screen.getByRole("link", { name: "The Matrix" })).toHaveAttribute("href", "/movies/m1");
    expect(document.querySelector(".video-set-strip [aria-current='page']")).toHaveTextContent("The Matrix Reloaded");
  });

  it("offers the next film of the set when a film ends", async () => {
    mockApi.mockResolvedValue({
      id: "m1", type: "movie", title: "The Matrix", show: null, season: null, episode: null, runtimeMinutes: 136, available: true, sizeBytes: 1000,
      playback: { mode: "direct", reasons: [], url: "/video/api/stream/m1", duration: 8000 }, progress: null, resumeAt: 0,
      next: { id: "m2", season: null, episode: null, title: "The Matrix Reloaded" }
    });
    renderSignedIn(<VideoPlayerPage id="m1" />);
    expect(await screen.findByRole("link", { name: "Up next: The Matrix Reloaded" })).toHaveAttribute("href", "/watch/m2");
  });
});

describe("skipping the intro and the credits", () => {
  const info = {
    id: "e2", type: "episode", title: "Birds of a Feather", show: { id: "s1", title: "Counterpart" }, season: 1, episode: 2,
    runtimeMinutes: null, available: true, sizeBytes: 1000,
    playback: { mode: "direct", reasons: [], url: "/video/api/stream/e2", duration: 2400 }, progress: null, resumeAt: 0,
    next: { id: "e3", season: 1, episode: 3, title: "The Lost Art of Diplomacy" },
    markers: { intro: { start: 60, end: 150, source: "chapter" }, credits: { start: 2300, source: "chapter" } }
  };
  const playerAt = (at: number, paused = false) => {
    const element = document.querySelector("video")!;
    Object.defineProperty(element, "currentTime", { configurable: true, writable: true, value: at });
    Object.defineProperty(element, "paused", { configurable: true, value: paused });
    fireEvent.timeUpdate(element);
    return element;
  };
  const saves = () => mockApi.mock.calls.filter(([path]) => path === "/video/api/progress/e2");

  it("offers Skip intro only while it plays, and goes to its end", async () => {
    mockApi.mockResolvedValue(info);
    renderSignedIn(<VideoPlayerPage id="e2" />);
    await screen.findByRole("heading", { name: "Counterpart" });
    playerAt(30);
    expect(screen.queryByRole("button", { name: "Skip intro" })).not.toBeInTheDocument();
    const element = playerAt(60);
    await userEvent.click(screen.getByRole("button", { name: "Skip intro" }));
    expect(element.currentTime).toBe(150);
    expect(screen.queryByRole("button", { name: "Skip intro" })).not.toBeInTheDocument();
    playerAt(100);
    expect(screen.getByRole("button", { name: "Skip intro" })).toBeInTheDocument();
    playerAt(150);
    expect(screen.queryByRole("button", { name: "Skip intro" })).not.toBeInTheDocument();
  });

  it("skips it with S, wherever the keyboard layout puts the letter", async () => {
    mockApi.mockResolvedValue(info);
    renderSignedIn(<VideoPlayerPage id="e2" />);
    await screen.findByRole("heading", { name: "Counterpart" });
    fireEvent.keyDown(window, { code: "KeyS", key: "s" });
    const element = playerAt(70);
    expect(element.currentTime).toBe(70);
    fireEvent.keyDown(window, { code: "KeyS", key: "ы" });
    expect(element.currentTime).toBe(150);
  });

  it("brings the end card up when the credits start, saving where it is, and Cancel lets them play", async () => {
    mockApi.mockResolvedValue(info);
    renderSignedIn(<VideoPlayerPage id="e2" />);
    await screen.findByRole("heading", { name: "Counterpart" });
    playerAt(2299);
    expect(screen.queryByText(/Next episode in/)).not.toBeInTheDocument();
    const before = saves().length;
    playerAt(2300);
    expect(screen.getByText("Next episode in 10 seconds")).toBeInTheDocument();
    expect(saves().length).toBe(before + 1);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/Next episode in/)).not.toBeInTheDocument();
    playerAt(2310);
    expect(screen.queryByText(/Next episode in/)).not.toBeInTheDocument();
    // Back before them and on again: offered again.
    playerAt(2000);
    playerAt(2301);
    expect(screen.getByText("Next episode in 10 seconds")).toBeInTheDocument();
  });

  it("never moves on from a paused film: pausing in the credits stops the card", async () => {
    mockApi.mockResolvedValue(info);
    renderSignedIn(<VideoPlayerPage id="e2" />);
    await screen.findByRole("heading", { name: "Counterpart" });
    playerAt(2300, true);
    expect(screen.queryByText(/Next episode in/)).not.toBeInTheDocument();
    const element = playerAt(2301);
    expect(screen.getByText("Next episode in 10 seconds")).toBeInTheDocument();
    fireEvent.pause(element);
    expect(screen.queryByText(/Next episode in/)).not.toBeInTheDocument();
  });

  it("shows no card at the credits of a film with nothing after it", async () => {
    mockApi.mockResolvedValue({ ...info, next: null });
    renderSignedIn(<VideoPlayerPage id="e2" />);
    await screen.findByRole("heading", { name: "Counterpart" });
    playerAt(2350);
    expect(screen.queryByText(/Next episode in/)).not.toBeInTheDocument();
  });

  it("changes nothing with an engine from before markers", async () => {
    mockApi.mockResolvedValue({ ...info, markers: undefined });
    renderSignedIn(<VideoPlayerPage id="e2" />);
    await screen.findByRole("heading", { name: "Counterpart" });
    playerAt(100);
    playerAt(2350);
    expect(screen.queryByRole("button", { name: "Skip intro" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Next episode in/)).not.toBeInTheDocument();
  });

  it("goes full screen as a page, where the browser can, so what is drawn over the picture stays", async () => {
    const requestFullscreen = vi.fn(() => Promise.resolve());
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: requestFullscreen });
    try {
      mockApi.mockResolvedValue(info);
      renderSignedIn(<VideoPlayerPage id="e2" />);
      await screen.findByRole("heading", { name: "Counterpart" });
      // The controls are the page's own, so nothing of the browser's covers them.
      expect(document.querySelector("video")).not.toHaveAttribute("controls");
      await userEvent.click(screen.getByRole("button", { name: "Full screen" }));
      expect(requestFullscreen.mock.contexts[0]).toBe(document.querySelector("main"));
    } finally {
      Reflect.deleteProperty(document, "fullscreenEnabled");
      Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
    }
  });

  it("lets an admin mark the credits for the whole season from where the film is, and the player follows the mark", async () => {
    const plain = { ...info, markers: { intro: null, credits: null } };
    mockApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/video/api/admin/markers/e2") {
        expect(JSON.parse(String(init?.body))).toEqual({ kind: "credits", scope: "season", start: 2250.5 });
        return { markers: { intro: null, credits: { start: 2250.5, source: "manual", scope: "season" } } };
      }
      return plain;
    });
    renderSignedIn(<VideoPlayerPage id="e2" />, { user: { id: "a1", role: "admin" } as never });
    await screen.findByRole("heading", { name: "Counterpart" });
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Mark intro" }));
    expect(screen.getByRole("tab", { name: "Whole season 1" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Save credits" })).toBeDisabled();
    playerAt(2250.54);
    // Recap start, recap end, intro start, intro end, credits start.
    await userEvent.click(screen.getAllByRole("button", { name: "Here" })[4]);
    await userEvent.click(screen.getByRole("button", { name: "Save credits" }));
    expect(await screen.findByText("Marked for season 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear mark" })).toBeInTheDocument();
    playerAt(2251);
    expect(screen.getByText("Next episode in 10 seconds")).toBeInTheDocument();
  });

  it("says when a time was found automatically, and asks the engine to look again", async () => {
    const found = { ...info, markers: { intro: { start: 60, end: 131, source: "detected" }, credits: null } };
    mockApi.mockImplementation(async (path: string) => (path === "/video/api/admin/markers/e2/detect" ? { queued: true } : found));
    renderSignedIn(<VideoPlayerPage id="e2" />, { user: { id: "a1", role: "admin" } as never });
    await screen.findByRole("heading", { name: "Counterpart" });
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Mark intro" }));
    expect(screen.getByText("Found automatically")).toBeInTheDocument();
    // A found time is not a mark: nothing to clear.
    expect(screen.queryByRole("button", { name: "Clear mark" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Find again" }));
    expect(await screen.findByText("Looking again")).toBeInTheDocument();
    expect(mockApi).toHaveBeenCalledWith("/video/api/admin/markers/e2/detect", { method: "POST" });
    expect(screen.getByRole("button", { name: "Find again" })).toBeDisabled();
  });

  it("offers Skip recap while the recap plays, then Skip intro, each going to its own end", async () => {
    mockApi.mockResolvedValue({ ...info, markers: { ...info.markers, recap: { start: 20, end: 55, source: "detected" } } });
    renderSignedIn(<VideoPlayerPage id="e2" />);
    await screen.findByRole("heading", { name: "Counterpart" });
    const element = playerAt(25);
    await userEvent.click(screen.getByRole("button", { name: "Skip recap" }));
    expect(element.currentTime).toBe(55);
    playerAt(70);
    expect(screen.getByRole("button", { name: "Skip intro" })).toBeInTheDocument();
    playerAt(30);
    fireEvent.keyDown(window, { code: "KeyS", key: "s" });
    expect(element.currentTime).toBe(55);
  });

  it("marks a recap for this episode only, whatever the tabs say", async () => {
    mockApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/video/api/admin/markers/e2") {
        expect(JSON.parse(String(init?.body))).toEqual({ kind: "recap", scope: "episode", start: 20, end: 61.5 });
        return { markers: { ...info.markers, recap: { start: 20, end: 61.5, source: "manual", scope: "episode" } } };
      }
      return info;
    });
    renderSignedIn(<VideoPlayerPage id="e2" />, { user: { id: "a1", role: "admin" } as never });
    await screen.findByRole("heading", { name: "Counterpart" });
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Mark intro" }));
    expect(screen.getByRole("tab", { name: "Whole season 1" })).toHaveAttribute("aria-selected", "true");
    playerAt(20);
    await userEvent.click(screen.getAllByRole("button", { name: "Here" })[0]);
    playerAt(61.5);
    await userEvent.click(screen.getAllByRole("button", { name: "Here" })[1]);
    await userEvent.click(screen.getByRole("button", { name: "Save recap" }));
    expect(await screen.findByText("Marked for this episode")).toBeInTheDocument();
  });

  it("offers marking to admins only", async () => {
    mockApi.mockResolvedValue(info);
    renderSignedIn(<VideoPlayerPage id="e2" />);
    await screen.findByRole("heading", { name: "Counterpart" });
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitem", { name: "Start over" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Mark intro" })).not.toBeInTheDocument();
  });

  it("leaves full screen to the browser where it can't", async () => {
    mockApi.mockResolvedValue(info);
    renderSignedIn(<VideoPlayerPage id="e2" />);
    await screen.findByRole("heading", { name: "Counterpart" });
    expect(screen.queryByRole("button", { name: "Full screen" })).not.toBeInTheDocument();
  });
});

describe("Add library → Video", () => {
  const wizard = (videoAvailable: boolean, onCreated = vi.fn()) => render(
    <LibraryWizard
      initialType="audiobook"
      videoAvailable={videoAvailable}
      users={[]}
      groups={[]}
      storageRoots={[]}
      initialRootId=""
      metadataSources={[]}
      typeDefaults={{}}
      onClose={() => undefined}
      onCreated={onCreated}
    />
  );

  it("offers Video only where the video app is set up", () => {
    wizard(false);
    expect(screen.queryByRole("radio", { name: /Video/ })).not.toBeInTheDocument();
  });

  it("creates a shows library on a folder of the video app", async () => {
    const onCreated = vi.fn();
    mockApi.mockImplementation((async (path: string, init?: RequestInit) => {
      if (path.startsWith("/api/library/video-folders")) {
        return path.includes("path=Shows")
          ? { path: "Shows", folders: [] }
          : { path: "", folders: [{ name: "Shows", path: "Shows", folders: 2 }] };
      }
      if (path === "/api/library/video-libraries" && init?.method === "POST") return { library: { id: "lib_new" } };
      throw new Error(`unexpected ${path}`);
    }) as never);
    wizard(true, onCreated);

    await userEvent.click(screen.getByRole("radio", { name: /Video/ }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.type(screen.getByLabelText("Library name"), "TV Shows");
    // Shows is the kind it starts on.
    expect(screen.getByRole("radio", { name: /Shows/ })).toHaveAttribute("aria-checked", "true");

    await userEvent.click(screen.getByRole("button", { name: "Browse" }));
    await userEvent.click(await screen.findByRole("button", { name: /Shows/ }));
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/api/library/video-folders?path=Shows"));
    await userEvent.click(screen.getByRole("button", { name: "Use this folder" }));
    expect(screen.getByText("Shows on the video app")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(screen.getByRole("button", { name: /Add library and scan|Add and scan/ }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const post = mockApi.mock.calls.find(([path, init]) => path === "/api/library/video-libraries" && (init as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse(String((post![1] as RequestInit).body))).toMatchObject({ name: "TV Shows", kind: "shows", folder: "Shows", visibility: "public" });
  });
});

describe("cast and crew", () => {
  const VideoPersonPage = async () => (await import("../src/features/video/VideoPersonPage")).VideoPersonPage;

  it("shows a title's cast as faces linking to each person, and its crew by job", async () => {
    mockApi.mockResolvedValue({
      id: "m1", libraryId: "lib_mov", title: "Д'Артаньян и три мушкетёра", originalTitle: null, year: 1979, plot: "Мушкетёры.", genres: [], runtimeMinutes: null,
      imdbId: null, tmdbId: null, source: "nfo", direct: "yes", progress: null,
      cast: [
        { id: "t8", name: "Михаил Боярский", role: "Д'Артаньян", photo: "/video/api/people/t8/photo?v=1" },
        { id: "nabc", name: "Someone Unknown", role: null, photo: null }
      ],
      crew: [
        { id: "t5", name: "Георгий Юнгвальд-Хилькевич", role: "director", photo: null },
        { id: "t6", name: "Writer One", role: "writer", photo: null },
        { id: "t7", name: "Writer Two", role: "writer", photo: null }
      ]
    });
    renderSignedIn(<VideoTitlePage kind="movies" id="m1" />);
    const cast = (await screen.findByRole("heading", { name: "Cast" })).closest("section")!;
    const boyarsky = within(cast).getByRole("link", { name: /Михаил Боярский/ });
    expect(boyarsky).toHaveAttribute("href", "/videos/people/t8");
    expect(boyarsky).toHaveTextContent("Д'Артаньян");
    expect(boyarsky.querySelector("img")).toHaveAttribute("src", "/video/api/people/t8/photo?v=1");
    // No picture: a placeholder face, still a link.
    expect(within(cast).getByRole("link", { name: /Someone Unknown/ }).querySelector("img")).toBeNull();
    const crew = document.querySelector(".video-crew")!;
    expect(crew).toHaveTextContent("Director: Георгий Юнгвальд-Хилькевич · Writers: Writer One, Writer Two");
    expect(within(crew as HTMLElement).getByRole("link", { name: "Writer Two" })).toHaveAttribute("href", "/videos/people/t7");
  });

  it("shows a person with their films and shows, the part played or the job done in each", async () => {
    mockApi.mockResolvedValue({
      id: "t8", name: "Михаил Боярский", tmdbId: "8", photo: "/video/api/people/t8/photo?v=1",
      titles: [
        { kind: "movies", id: "m1", title: "Д'Артаньян и три мушкетёра", year: 1979, poster: "/p.jpg", characters: ["Д'Артаньян"], jobs: [], actor: true },
        { kind: "shows", id: "s1", title: "A Show", year: 1990, poster: "/q.jpg", characters: [], jobs: ["director"], actor: false }
      ]
    });
    const Page = await VideoPersonPage();
    renderSignedIn(<Page id="t8" />);
    expect(await screen.findByRole("heading", { name: "Михаил Боярский" })).toBeInTheDocument();
    expect(mockApi).toHaveBeenCalledWith("/video/api/people/t8");
    expect(screen.getByText("2 films and shows")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Д'Артаньян и три мушкетёра/ })).toHaveAttribute("href", "/movies/m1");
    expect(screen.getByText("1979 · as Д'Артаньян")).toBeInTheDocument();
    expect(screen.getByText("1990 · Director")).toBeInTheDocument();
  });

  it("says so when the person isn't in anything this person can watch", async () => {
    mockApi.mockRejectedValue(new Error("No such person"));
    const Page = await VideoPersonPage();
    renderSignedIn(<Page id="t99" />);
    expect(await screen.findByText("This person isn't in anything you can watch here.")).toBeInTheDocument();
  });

  it("reads the person's address", () => {
    at("/videos/people/t8");
    expect(getRoute()).toEqual({ name: "videoPerson", id: "t8" });
  });
});
