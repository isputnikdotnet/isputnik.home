import { render, screen, waitFor } from "@testing-library/react";
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
