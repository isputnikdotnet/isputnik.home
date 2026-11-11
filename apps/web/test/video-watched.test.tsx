import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderSignedIn } from "./helpers/session";

// Marking watched by hand on a title's page (issue #101, phase 1): the engine's
// PUT /progress takes `watched`, and the page reads the title again afterwards.

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});

const { api } = await import("../src/api");
const { VideoTitlePage } = await import("../src/features/video/VideoTitlePage");
const { inProgress, knownDuration } = await import("../src/features/video/watched");
const mockApi = vi.mocked(api);

const film = {
  id: "m1", libraryId: "lib_mov", title: "The General", originalTitle: null, year: 1926, plot: null, genres: [], runtimeMinutes: 67,
  imdbId: null, tmdbId: null, source: "nfo", direct: "yes", progress: null as object | null, poster: null, backdrop: null
};

const episode = (id: string, number: number, progress: object | null) =>
  ({ id, episode: number, title: `Episode ${number}`, plot: null, aired: null, runtimeMinutes: 40, direct: "yes", progress });

const show = (first: object | null, second: object | null) => ({
  id: "s1", libraryId: "lib_tv", title: "Counterpart", originalTitle: null, year: 2017, plot: null, premiered: null, status: null, genres: [],
  imdbId: null, tmdbId: null, source: "nfo", poster: null, backdrop: null,
  seasons: [{ number: 1, episodes: [episode("e1", 1, first), episode("e2", 2, second)] }],
  nextUp: { id: "e1", season: 1, episode: 1, title: "Episode 1", position: 0 }
});

/** What was sent to the engine's progress route, in order. */
const marks = () => mockApi.mock.calls
  .filter(([path, init]) => String(path).startsWith("/video/api/progress/") && init?.method === "PUT")
  .map(([path, init]) => ({ id: String(path).split("/").pop(), ...JSON.parse(String(init!.body)) }));

beforeEach(() => mockApi.mockReset());

describe("watched helpers", () => {
  it("call a film in progress only once there is a place worth coming back to", () => {
    expect(inProgress(null)).toBe(false);
    expect(inProgress({ position: 12, duration: 600, watched: false, updatedAt: "" })).toBe(false);
    expect(inProgress({ position: 120, duration: 600, watched: false, updatedAt: "" })).toBe(true);
    expect(inProgress({ position: 590, duration: 600, watched: true, updatedAt: "" })).toBe(false);
  });

  it("take the length the player measured before the listed running time", () => {
    expect(knownDuration({ position: 0, duration: 4011, watched: false, updatedAt: "" }, 67)).toBe(4011);
    expect(knownDuration(null, 67)).toBe(4020);
    expect(knownDuration(null, null)).toBeNull();
  });
});

describe("marking a film", () => {
  it("marks it watched at its end, then offers to mark it unwatched", async () => {
    let current = film;
    mockApi.mockImplementation((async (path: string, init?: RequestInit) => {
      if (path === "/video/api/movies/m1") return current;
      if (path === "/video/api/progress/m1" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        current = { ...film, progress: { ...body, updatedAt: "2026-11-11T00:00:00.000Z" } };
        return { progress: current.progress };
      }
      return {};
    }) as never);
    renderSignedIn(<VideoTitlePage kind="movies" id="m1" />);

    await userEvent.click(await screen.findByRole("button", { name: "Mark as watched" }));
    await waitFor(() => expect(marks()).toEqual([{ id: "m1", position: 4020, duration: 4020, watched: true }]));

    // Read again from the engine: watched now, so the way back is offered.
    await userEvent.click(await screen.findByRole("button", { name: "Mark as unwatched" }));
    await waitFor(() => expect(marks()[1]).toEqual({ id: "m1", position: 0, duration: 4020, watched: false }));
    expect(await screen.findByRole("button", { name: "Mark as watched" })).toBeInTheDocument();
  });

  it("marks every part of a film in several files, the first last when it is to be watched again", async () => {
    const seen = { position: 3000, duration: 3000, watched: true, updatedAt: "2026-11-10T00:00:00.000Z" };
    const parts = { ...film, progress: seen, parts: [{ id: "m1", part: 1, direct: "yes", progress: seen }, { id: "p2", part: 2, direct: "yes", progress: seen }] };
    mockApi.mockImplementation((async (path: string, init?: RequestInit) => {
      if (path === "/video/api/movies/m1") return parts;
      if (String(path).startsWith("/video/api/progress/") && init?.method === "PUT") return { progress: null };
      return {};
    }) as never);
    renderSignedIn(<VideoTitlePage kind="movies" id="m1" />);

    await userEvent.click(await screen.findByRole("button", { name: "Mark as unwatched" }));
    // The part marked last is where the engine starts the film: part 1.
    await waitFor(() => expect(marks().map((mark) => mark.id)).toEqual(["p2", "m1"]));
    expect(marks().every((mark) => mark.watched === false && mark.position === 0)).toBe(true);
  });
});

describe("marking an episode", () => {
  it("offers Mark as watched from its menu, and Reset progress for one left part-way", async () => {
    const halfway = { position: 900, duration: 2400, watched: false, updatedAt: "2026-11-10T00:00:00.000Z" };
    mockApi.mockImplementation((async (path: string, init?: RequestInit) => {
      if (path === "/video/api/shows/s1") return show(null, halfway);
      if (String(path).startsWith("/video/api/progress/") && init?.method === "PUT") return { progress: null };
      return {};
    }) as never);
    renderSignedIn(<VideoTitlePage kind="shows" id="s1" />);

    // Never started: one thing to do.
    await userEvent.click(await screen.findByRole("button", { name: "More for Episode 1" }));
    expect(screen.queryByRole("menuitem", { name: "Reset progress" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: "Mark as watched" }));
    await waitFor(() => expect(marks()).toEqual([{ id: "e1", position: 2400, duration: 2400, watched: true }]));

    // Left part-way: its place can be dropped, with the length the player measured.
    await userEvent.click(screen.getByRole("button", { name: "More for Episode 2" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Reset progress" }));
    await waitFor(() => expect(marks()[1]).toEqual({ id: "e2", position: 0, duration: 2400, watched: false }));
  });

  it("says so when the mark could not be saved", async () => {
    mockApi.mockImplementation((async (path: string, init?: RequestInit) => {
      if (path === "/video/api/shows/s1") return show(null, null);
      if (init?.method === "PUT") return Promise.reject(new Error("Video is not available right now"));
      return {};
    }) as never);
    renderSignedIn(<VideoTitlePage kind="shows" id="s1" />);
    await userEvent.click(await screen.findByRole("button", { name: "More for Episode 1" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Mark as watched" }));
    expect(await screen.findByText("Unable to save the mark")).toBeInTheDocument();
    expect(screen.getByText("Video is not available right now")).toBeInTheDocument();
  });
});

// Phase 2: where a person is shows on every poster, a list narrows by it, and a
// whole show or season is marked in one call (engine 0.32+).
const { VideoHomePage } = await import("../src/features/video/VideoHomePage");

const cardOf = (title: string) => screen.getByRole("link", { name: new RegExp(title) }).closest(".video-card-frame") as HTMLElement;

describe("posters in browse", () => {
  const seen = { position: 4020, duration: 4020, watched: true, updatedAt: "" };
  const partway = { position: 1200, duration: 4000, watched: false, updatedAt: "" };
  const cards = [
    { kind: "movies", id: "m1", libraryId: "l", title: "Finished Film", year: 2001, imdbId: null, genres: [], runtimeMinutes: 67, poster: "/p1", progress: seen, playId: "m1" },
    { kind: "movies", id: "m2", libraryId: "l", title: "Halfway Film", year: 2002, imdbId: null, genres: [], runtimeMinutes: 67, poster: "/p2", progress: partway, playId: "m2" },
    { kind: "shows", id: "s1", libraryId: "l", title: "Long Show", year: 2003, imdbId: null, genres: [], seasons: 2, episodes: 10, poster: "/p3", watchedEpisodes: 2, started: true, playId: "e3" },
    { kind: "shows", id: "s2", libraryId: "l", title: "New Show", year: 2004, imdbId: null, genres: [], seasons: 1, episodes: 6, poster: "/p4", watchedEpisodes: 0, started: false, playId: "n1" }
  ];
  const answer = (tracked: boolean) => (async (path: string, init?: RequestInit) => {
    const url = String(path);
    if (url.startsWith("/video/api/titles?")) return { items: cards, total: cards.length, page: 1, pageSize: 200, ...(tracked ? { watch: true } : {}) };
    if (url.startsWith("/video/api/watched/") && init?.method === "PUT") return { marked: 10 };
    if (url === "/video/api/libraries") return { libraries: [] };
    if (url.startsWith("/video/api/genres")) return { genres: [] };
    if (url.startsWith("/video/api/sets")) return { items: [], total: 0, page: 1, pageSize: 200 };
    if (url === "/api/video/home") return { rows: [], custom: false, mine: false, editable: false };
    if (url === "/api/profiles") return { profiles: [], current: null, editable: false };
    if (url === "/video/api/continue") return { items: [] };
    return {};
  }) as never;
  const sent = (prefix: string) => mockApi.mock.calls.filter(([path]) => String(path).startsWith(prefix));

  beforeEach(() => window.history.replaceState({}, "", "/videos?view=grid"));

  it("draw a check on a finished film, a bar on one left part-way and a count on a show with episodes to see", async () => {
    mockApi.mockImplementation(answer(true));
    renderSignedIn(<VideoHomePage />);
    await screen.findByRole("link", { name: /Finished Film/ });
    expect(within(cardOf("Finished Film")).getByRole("img", { name: "Watched" })).toBeInTheDocument();
    expect(cardOf("Finished Film").querySelector(".video-card-progress")).toBeNull();
    expect(cardOf("Halfway Film").querySelector<HTMLElement>(".video-card-progress span")!.style.width).toBe("30%");
    expect(within(cardOf("Long Show")).getByText("8 unwatched")).toBeInTheDocument();
    expect(cardOf("Long Show").querySelector<HTMLElement>(".video-card-progress span")!.style.width).toBe("20%");
    // Never started: the poster says nothing.
    expect(cardOf("New Show").querySelector(".video-card-badge, .video-card-progress, .video-card-watched")).toBeNull();
  });

  it("offer only what applies from a card's menu, and mark a film at once", async () => {
    mockApi.mockImplementation(answer(true));
    renderSignedIn(<VideoHomePage />);
    await userEvent.click(await screen.findByRole("button", { name: "More for Halfway Film" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Play", "Mark as watched", "Reset progress"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Mark as watched" }));
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/video/api/watched/movies/m2", expect.objectContaining({ method: "PUT", body: JSON.stringify({ watched: true }) })));
    // The grid reads its titles again.
    await waitFor(() => expect(sent("/video/api/titles?pageSize=200").length).toBeGreaterThan(1));

    await userEvent.click(screen.getByRole("button", { name: "More for Finished Film" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Play", "Mark as unwatched"]);
  });

  it("ask before marking a whole show", async () => {
    mockApi.mockImplementation(answer(true));
    renderSignedIn(<VideoHomePage />);
    await userEvent.click(await screen.findByRole("button", { name: "More for Long Show" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Mark as watched" }));
    expect(sent("/video/api/watched/")).toHaveLength(0);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Mark all of \"Long Show\" as watched?")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark as watched" }));
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/video/api/watched/shows/s1", expect.objectContaining({ method: "PUT", body: JSON.stringify({ watched: true }) })));
  });

  it("narrow the grid by the Watched filter kept in the address", async () => {
    window.history.replaceState({}, "", "/videos?watch=progress,nonsense");
    mockApi.mockImplementation(answer(true));
    renderSignedIn(<VideoHomePage />);
    await waitFor(() => expect(sent("/video/api/titles?").some(([path]) => new URLSearchParams(String(path).split("?")[1]).get("watch") === "progress")).toBe(true));
    // The chip says it in words.
    expect(await screen.findByText("In progress")).toBeInTheDocument();
  });

  it("stay plain, with no menus or filter, on an engine that tracks none of it", async () => {
    mockApi.mockImplementation(answer(false));
    renderSignedIn(<VideoHomePage />);
    await screen.findByRole("link", { name: /Finished Film/ });
    expect(screen.queryByRole("button", { name: /More for/ })).not.toBeInTheDocument();
    expect(document.querySelector(".video-card-watched, .video-card-badge")).toBeNull();
  });
});

describe("marking a season", () => {
  it("counts the season's episodes seen, and marks them all after asking", async () => {
    const seenEpisode = { position: 2400, duration: 2400, watched: true, updatedAt: "" };
    mockApi.mockImplementation((async (path: string, init?: RequestInit) => {
      if (path === "/video/api/shows/s1") return { ...show(seenEpisode, null), marksAll: true };
      if (String(path).startsWith("/video/api/watched/") && init?.method === "PUT") return { marked: 2 };
      return {};
    }) as never);
    renderSignedIn(<VideoTitlePage kind="shows" id="s1" />);
    expect(await screen.findByText("1/2 watched")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "More for Season 1" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Mark season as watched" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Mark all of \"Counterpart · Season 1\" as watched?")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark as watched" }));
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/video/api/watched/shows/s1", expect.objectContaining({ method: "PUT", body: JSON.stringify({ watched: true, season: 1 }) })));
  });

  it("offers nothing for a whole show on an engine that can't mark one", async () => {
    mockApi.mockImplementation((async (path: string) => (path === "/video/api/shows/s1" ? show(null, null) : {})) as never);
    renderSignedIn(<VideoTitlePage kind="shows" id="s1" />);
    expect(await screen.findByText("0/2 watched")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More for Season 1" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark as watched" })).not.toBeInTheDocument();
  });
});
