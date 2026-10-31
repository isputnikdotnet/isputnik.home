import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const { VideoBrowsePage } = await import("../src/features/video/VideoBrowsePage");
const { VideoTitlePage } = await import("../src/features/video/VideoTitlePage");
const { VideoPlayerPage } = await import("../src/features/video/VideoPlayerPage");
const { VideoSetPage } = await import("../src/features/video/VideoSetPage");
const { LibraryWizard } = await import("../src/features/control/libraries/LibraryWizard");
const mockApi = vi.mocked(api);

const at = (url: string) => window.history.replaceState({}, "", url);

beforeEach(() => {
  mockApi.mockReset();
  at("/");
});

describe("video routes", () => {
  it("reads Shows, Movies and one title of either, never under /video", () => {
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

describe("Shows", () => {
  it("lists the shows the engine answers with, and offers its libraries as a filter", async () => {
    mockApi.mockImplementation((async (path: string) => {
      if (path === "/video/api/libraries") return { libraries: [{ id: "lib_tv", name: "TV", kind: "shows" }, { id: "lib_kids", name: "Kids", kind: "shows" }, { id: "lib_mov", name: "Films", kind: "movies" }] };
      if (path.startsWith("/video/api/shows")) return shows;
      throw new Error(`unexpected ${path}`);
    }) as never);
    renderSignedIn(<VideoBrowsePage kind="shows" />);
    expect(await screen.findByText("Counterpart")).toBeInTheDocument();
    expect(screen.getByText("2017 · 2 seasons · 20 episodes")).toBeInTheDocument();
    expect(screen.getByText("2 shows")).toBeInTheDocument();
    expect(mockApi).toHaveBeenCalledWith("/video/api/shows?sort=title&pageSize=200");
  });

  it("says plainly when the engine cannot answer", async () => {
    mockApi.mockImplementation((async (path: string) => {
      if (path === "/video/api/libraries") return { libraries: [] };
      throw new Error("The video app did not answer.");
    }) as never);
    renderSignedIn(<VideoBrowsePage kind="shows" />);
    expect(await screen.findByText("Video is not available right now")).toBeInTheDocument();
  });

  it("asks again when the search settles", async () => {
    mockApi.mockImplementation((async (path: string) => (path === "/video/api/libraries" ? { libraries: [] } : shows)) as never);
    renderSignedIn(<VideoBrowsePage kind="shows" />);
    await userEvent.type(await screen.findByPlaceholderText("Search shows"), "rad");
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/video/api/shows?sort=title&pageSize=200&q=rad"));
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
      throw new Error(`unexpected ${path}`);
    }) as never);
    renderSignedIn(<VideoTitlePage kind="movies" id="m1" />, { user: { id: "a1", role: "admin" } as never });
    expect(await screen.findByRole("heading", { name: "Loose Film" })).toBeInTheDocument();
    expect(document.querySelector(".video-title-cover img")).toHaveAttribute("src", "/video/api/art/m1/poster?v=1");
    expect(document.querySelector(".video-title-backdrop img")).toHaveAttribute("src", "/video/api/art/m1/backdrop?v=1");

    await userEvent.click(screen.getByRole("button", { name: "Fix match" }));
    await userEvent.click(screen.getByRole("button", { name: "Search TMDB" }));
    expect(mockApi).toHaveBeenCalledWith("/video/api/admin/metadata/search?kind=movie&q=Loose+Film&language=en&year=1999");
    await userEvent.click(await screen.findByRole("button", { name: /The Right Film \(1999\)/ }));
    expect(mockApi).toHaveBeenCalledWith("/video/api/admin/metadata/items/m1", expect.objectContaining({ method: "PUT", body: JSON.stringify({ tmdbId: "404" }) }));
    expect(await screen.findByText("The one.")).toBeInTheDocument();
    expect(screen.getByText(/★ 6\.0/)).toBeInTheDocument();
  });

  it("offers Fix match to admins only", async () => {
    mockApi.mockResolvedValue({
      id: "m1", libraryId: "lib_mov", title: "Loose Film", originalTitle: null, year: 1999, plot: null, genres: [], runtimeMinutes: null,
      imdbId: null, tmdbId: null, source: "folder", direct: "yes", progress: null
    });
    renderSignedIn(<VideoTitlePage kind="movies" id="m1" />);
    expect(await screen.findByRole("heading", { name: "Loose Film" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fix match" })).not.toBeInTheDocument();
    // An engine older than 0.6.0 sends no poster: the kind's icon stays.
    expect(document.querySelector(".video-title-cover img")).toBeNull();
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

      await userEvent.click(screen.getByRole("button", { name: "Sound: English · 5.1" }));
      await userEvent.click(screen.getByRole("option", { name: /Russian · Дубляж · Stereo/ }));
      expect(mockApi).toHaveBeenCalledWith("/video/api/play/e2?audio=2");
      await waitFor(() => expect(hlsCalls.source).toBe("/video/api/hls/e2/t2/index.m3u8"));
      expect(screen.getByRole("button", { name: "Sound: Russian · Дубляж · Stereo" })).toBeInTheDocument();
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
      expect(screen.queryByRole("button", { name: /^Sound/ })).not.toBeInTheDocument();
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
      expect(screen.getByRole("option", { name: "Russian · SDH" })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("option", { name: "English" }));
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
      await userEvent.click(screen.getByRole("option", { name: "French" }));
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

  it("switches Movies to its Sets and keeps the choice in the address", async () => {
    mockApi.mockImplementation((async (path: string) => {
      if (path === "/video/api/libraries") return { libraries: [] };
      if (path === "/video/api/continue?limit=12" || path.startsWith("/video/api/continue")) return { items: [] };
      if (path.startsWith("/video/api/sets")) return page([summary]);
      if (path.startsWith("/video/api/movies")) return page([{ id: "m1", libraryId: "lib", title: "The Matrix", year: 1999, imdbId: null, genres: [], runtimeMinutes: 136 }]);
      throw new Error(`unexpected ${path}`);
    }) as never);
    at("/movies");
    renderSignedIn(<VideoBrowsePage kind="movies" />);
    expect(await screen.findByText("The Matrix")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "View: Films" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Sets" }));
    expect(await screen.findByText("The Matrix Collection")).toBeInTheDocument();
    expect(screen.getByText("3 films · 1999–2003")).toBeInTheDocument();
    expect(screen.getByText("1 set")).toBeInTheDocument();
    expect(window.location.search).toBe("?view=sets");
    expect(mockApi).toHaveBeenCalledWith("/video/api/sets?pageSize=200");
    // Sets are by name: no Sort while they show.
    expect(screen.queryByRole("button", { name: /^Sort:/ })).not.toBeInTheDocument();
  });

  it("offers no View where there are no sets, as with an engine from before them", async () => {
    mockApi.mockImplementation((async (path: string) => {
      if (path === "/video/api/libraries") return { libraries: [] };
      if (path.startsWith("/video/api/continue")) return { items: [] };
      if (path.startsWith("/video/api/sets")) throw new Error("Not Found");
      if (path.startsWith("/video/api/movies")) return page([]);
      throw new Error(`unexpected ${path}`);
    }) as never);
    renderSignedIn(<VideoBrowsePage kind="movies" />);
    expect(await screen.findByText("Nothing here yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^View:/ })).not.toBeInTheDocument();
  });

  it("plays on from the first film not yet watched, and lists the films in order", async () => {
    mockApi.mockResolvedValue(matrix);
    renderSignedIn(<VideoSetPage id="set1" />);
    expect(await screen.findByRole("heading", { name: "The Matrix Collection" })).toBeInTheDocument();
    expect(mockApi).toHaveBeenCalledWith("/video/api/sets/set1");
    expect(screen.getByText("3 films · 1999–2003 · 1 of 3 watched")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Resume The Matrix Reloaded from 12:34" })).toHaveAttribute("href", "/watch/m2");
    expect(screen.getAllByRole("listitem").map((item) => item.querySelector(".video-card-body strong")?.textContent)).toEqual(["The Matrix", "The Matrix Reloaded", "The Matrix Revolutions"]);
    expect(screen.getByRole("link", { name: /The Matrix Revolutions/ })).toHaveAttribute("href", "/movies/m3");
    expect(screen.getByRole("link", { name: "Sets" })).toHaveAttribute("href", "/movies?view=sets");
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
      expect(document.querySelector("video")).toHaveAttribute("controlslist", "nofullscreen");
      await userEvent.click(screen.getByRole("button", { name: "Full screen" }));
      expect(requestFullscreen.mock.contexts[0]).toBe(document.querySelector("main"));
    } finally {
      Reflect.deleteProperty(document, "fullscreenEnabled");
      Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
    }
  });

  it("leaves full screen to the browser where it can't", async () => {
    mockApi.mockResolvedValue(info);
    renderSignedIn(<VideoPlayerPage id="e2" />);
    await screen.findByRole("heading", { name: "Counterpart" });
    expect(document.querySelector("video")).not.toHaveAttribute("controlslist");
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
