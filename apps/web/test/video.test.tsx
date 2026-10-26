import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRoute } from "../src/router";
import { renderSignedIn } from "./helpers/session";

// Video in the home app (docs/video-architecture.md): the pages over the
// engine's catalog, and Add library → Video. The engine is reached through
// /video/api; here api() answers for it.

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});

const { api } = await import("../src/api");
const { VideoBrowsePage } = await import("../src/features/video/VideoBrowsePage");
const { VideoTitlePage } = await import("../src/features/video/VideoTitlePage");
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
        { id: "e1", episode: 1, title: "Серия 1", plot: null, aired: "2026-04-24", runtimeMinutes: null },
        { id: "e2", episode: 2, title: null, plot: null, aired: null, runtimeMinutes: null }
      ] }]
    });
    renderSignedIn(<VideoTitlePage kind="shows" id="s2" />);
    expect(await screen.findByRole("heading", { name: "Радар" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Season 1" })).toBeInTheDocument();
    expect(screen.getByText("Серия 1")).toBeInTheDocument();
    // An episode the engine has no title for is named by its number.
    expect(screen.getByText("Episode 2")).toBeInTheDocument();
    expect(mockApi).toHaveBeenCalledWith("/video/api/shows/s2");
  });

  it("says so when the title is gone or not this person's", async () => {
    mockApi.mockRejectedValue(new Error("No such show"));
    renderSignedIn(<VideoTitlePage kind="shows" id="gone" />);
    expect(await screen.findByText("This is not here any more, or not for you.")).toBeInTheDocument();
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
