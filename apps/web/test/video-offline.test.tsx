import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSignedIn } from "./helpers/session";

// Films kept on this device (offline/video.ts): the downloader over a store in
// memory, the loader hls.js reads a converted copy through, and the player
// choosing the copy here over the server's.

const hlsCalls = vi.hoisted(() => ({ config: null as Record<string, unknown> | null, source: "" }));
vi.mock("hls.js", () => {
  class FakeHls {
    static isSupported() { return true; }
    static Events = { MANIFEST_PARSED: "hlsManifestParsed", ERROR: "hlsError" };
    static ErrorTypes = { MEDIA_ERROR: "mediaError" };
    constructor(config: Record<string, unknown>) { hlsCalls.config = config; }
    on() { return undefined; }
    loadSource(url: string) { hlsCalls.source = url; }
    attachMedia() { return undefined; }
    recoverMediaError() { return undefined; }
    destroy() { return undefined; }
  }
  return { default: FakeHls };
});

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});

const { api, ApiError } = await import("../src/api");
const { VideoDownloads, estimateVideoBytes, getOfflineVideo, playlistSegments, videoDownloads } = await import("../src/offline/video");
const { memoryVideoStore } = await import("../src/offline/video-store");
const { offlineHlsLoader } = await import("../src/features/video/offlineSource");
const { VideoPlayerPage } = await import("../src/features/video/VideoPlayerPage");
const { suggestedRung } = await import("../src/features/video/VideoDownloads");
const mockApi = vi.mocked(api);

type Store = ReturnType<typeof memoryVideoStore>;

const PLAYLIST = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXTINF:6.000,", "0.ts", "#EXTINF:6.000,", "1.ts", "#EXTINF:4.000,", "2.ts", "#EXT-X-ENDLIST", ""].join("\n");

const playInfo = (playback: Record<string, unknown>) => ({
  id: "e2",
  type: "episode",
  title: "Birds of a Feather",
  show: { id: "s1", title: "Counterpart" },
  season: 1,
  episode: 2,
  runtimeMinutes: 1,
  available: true,
  sizeBytes: 20 * 1024 * 1024,
  playback: { reasons: [], duration: 16, busy: null, ...playback },
  audioTracks: [],
  subtitleTracks: [],
  progress: null,
  resumeAt: 0,
  next: null
});

const request = { id: "e2", title: "Birds of a Feather", showTitle: "Counterpart", season: 1, episode: 2, runtimeMinutes: 1 };
const options = { quality: 720 as const, parent: { kind: "shows" as const, id: "s1" }, posterUrl: null };

/** Waits until the download is in `state`. */
const reaches = (store: Store, state: string) => waitFor(async () => expect((await store.get("e2"))?.state).toBe(state));

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  mockApi.mockReset();
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("estimateVideoBytes", () => {
  it("is the file for the original, and never more than the file for a rung", () => {
    expect(estimateVideoBytes(5_000, 3600, null)).toBe(5_000);
    // An hour at 720p: about 1.4 GB.
    expect(estimateVideoBytes(null, 3600, 720)).toBe(1_407_600_000);
    expect(estimateVideoBytes(900_000_000, 3600, 720)).toBe(900_000_000);
    expect(estimateVideoBytes(null, null, 720)).toBeNull();
  });
});

/** The engine's answers before it prepared copies: how a film plays, and no word of copies. */
const oldEngine = (play: unknown) => (async (path: string) => {
  if (String(path).startsWith("/video/api/copies/")) throw new ApiError("Not found", 404);
  return play;
}) as never;

describe("downloading a converted film from an engine that prepares no copies", () => {
  const hls = { mode: "transcode", url: "/video/api/hls/e2/t1q720/index.m3u8", quality: { current: 720, allowed: [null, 1080, 720, 480], network: "home" } };

  it("keeps the playlist and every segment, then gives the engine its place back", async () => {
    const store = memoryVideoStore();
    mockApi.mockImplementation(oldEngine(playInfo(hls)));
    fetchMock.mockImplementation(async (url, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (String(url).endsWith("index.m3u8")) return new Response(PLAYLIST);
      return new Response(`segment ${String(url).split("/").pop()}`);
    });
    const downloads = new VideoDownloads(() => store);
    await downloads.enqueue([request], options);
    await reaches(store, "complete");

    expect(mockApi).toHaveBeenCalledWith("/video/api/play/e2?quality=720");
    const record = (await store.get("e2"))!;
    expect(record).toMatchObject({ kind: "hls", playlist: PLAYLIST, totalParts: 3, doneParts: 3, quality: 720, showTitle: "Counterpart" });
    expect(playlistSegments(record.playlist!)).toEqual(["0.ts", "1.ts", "2.ts"]);
    expect(await (await store.getPart("e2", 2))!.text()).toBe("segment 2.ts");
    expect(record.totalBytes).toBe(record.downloadedBytes);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/video/api/hls/e2", expect.objectContaining({ method: "DELETE" })));
    expect(downloads.getSnapshot().get("e2")?.state).toBe("complete");
  });

  it("carries on from the segment it was paused at", async () => {
    const store = memoryVideoStore();
    mockApi.mockImplementation(oldEngine(playInfo(hls)));
    const asked: string[] = [];
    let stall = true;
    fetchMock.mockImplementation((url, init) => {
      if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      const name = String(url).split("/").pop()!;
      asked.push(name);
      if (name === "index.m3u8") return Promise.resolve(new Response(PLAYLIST));
      // The second segment never arrives the first time round.
      if (name === "1.ts" && stall) {
        return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
      }
      return Promise.resolve(new Response(name));
    });
    const downloads = new VideoDownloads(() => store);
    await downloads.enqueue([request], options);
    await waitFor(async () => expect((await store.get("e2"))?.doneParts).toBe(1));
    await downloads.pause("e2");
    expect((await store.get("e2"))).toMatchObject({ state: "paused", doneParts: 1 });

    stall = false;
    asked.length = 0;
    await downloads.resume("e2");
    await reaches(store, "complete");
    // The first segment is not fetched again, and the engine is not asked again how it plays.
    expect(asked).toEqual(["index.m3u8", "1.ts", "2.ts"]);
    expect(mockApi.mock.calls.filter(([path]) => String(path).startsWith("/video/api/play/"))).toHaveLength(1);
  });

  it("gives way while a film is watched from the server", async () => {
    const store = memoryVideoStore();
    mockApi.mockImplementation(oldEngine(playInfo(hls)));
    let stall = true;
    fetchMock.mockImplementation((url, init) => {
      if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      const name = String(url).split("/").pop()!;
      if (name === "index.m3u8") return Promise.resolve(new Response(PLAYLIST));
      if (stall) return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
      return Promise.resolve(new Response(name));
    });
    const downloads = new VideoDownloads(() => store);
    await downloads.enqueue([request], options);
    await waitFor(async () => expect((await store.get("e2"))?.totalParts).toBe(3));

    const hold = downloads.hold();
    await hold.ready;
    // Its place on the engine is free before the player asks for one, and it is still meant to download.
    expect(fetchMock).toHaveBeenCalledWith("/video/api/hls/e2", expect.objectContaining({ method: "DELETE" }));
    expect((await store.get("e2"))?.state).toBe("downloading");

    stall = false;
    hold.release();
    await reaches(store, "complete");
  });

  it("fails for good when the film has gone from the library", async () => {
    const store = memoryVideoStore();
    mockApi.mockRejectedValue(new ApiError("Not found", 404));
    const downloads = new VideoDownloads(() => store);
    await downloads.enqueue([request], options);
    await reaches(store, "failed");
    expect((await store.get("e2"))?.problem).toBe("gone");
  });
});

describe("downloading a copy the server prepares", () => {
  const hls = { mode: "transcode", url: "/video/api/hls/e2/t1q720/index.m3u8", quality: { current: 720, allowed: [null, 1080, 720, 480], network: "home" } };
  const copyUrl = "/video/api/copies/e2/file?quality=720&audio=1";
  const info = { ...playInfo(hls), audioTracks: [{ index: 1, codec: "ac3", channels: 6, language: "eng", title: null, default: true, selected: true }] };

  /** The server's side: the copy's state, and the file once it is ready. */
  function server(copy: { state: string }) {
    const asked: { method: string; path: string }[] = [];
    mockApi.mockImplementation((async (path: string, init?: RequestInit) => {
      asked.push({ method: init?.method ?? "GET", path: String(path) });
      if (String(path).startsWith("/video/api/copies/")) {
        return copy.state === "ready" ? { state: "ready", progress: 1, url: copyUrl, sizeBytes: 9 } : { state: copy.state, progress: 0.4, ahead: 0, paused: false, etaSeconds: 60 };
      }
      return info;
    }) as never);
    fetchMock.mockImplementation(async (url) => {
      if (String(url) !== copyUrl) return new Response(null, { status: 404 });
      return new Response("the copy!", { status: 206, headers: { "Content-Range": "bytes 0-8/9", "Content-Type": "video/mp4" } });
    });
    return asked;
  }

  it("asks for it, waits without holding the queue, and fetches the one file once it is ready", async () => {
    const store = memoryVideoStore();
    const copy = { state: "running" };
    const asked = server(copy);
    const downloads = new VideoDownloads(() => store);
    await downloads.enqueue([request], options);
    await reaches(store, "preparing");
    // Asked for with the sound track that plays, and nothing fetched meanwhile.
    expect(asked).toContainEqual({ method: "PUT", path: "/video/api/copies/e2" });
    expect(JSON.parse(String(mockApi.mock.calls.find(([, init]) => init?.method === "PUT")![1]!.body))).toEqual({ quality: 720, audio: 1 });
    expect((await store.get("e2"))?.prepare).toMatchObject({ progress: 0.4 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(downloads.busy).toBe(false);

    copy.state = "ready";
    await downloads.lookAtPreparing();
    await reaches(store, "complete");
    expect(await store.get("e2")).toMatchObject({ kind: "file", fileUrl: copyUrl, mime: "video/mp4", totalBytes: 9, quality: 720, prepare: null });
    expect(await (await store.getParts("e2"))[0].text()).toBe("the copy!");
  });

  it("starts at once when the copy is already there", async () => {
    const store = memoryVideoStore();
    server({ state: "ready" });
    const downloads = new VideoDownloads(() => store);
    await downloads.enqueue([request], options);
    await reaches(store, "complete");
    expect((await store.get("e2"))?.fileUrl).toBe(copyUrl);
  });

  it("says so when the server could not prepare it, and asks afresh on Resume", async () => {
    const store = memoryVideoStore();
    const copy = { state: "failed" };
    server(copy);
    const downloads = new VideoDownloads(() => store);
    await downloads.enqueue([request], options);
    await reaches(store, "failed");
    expect((await store.get("e2"))?.problem).toBe("prepare");
    copy.state = "ready";
    await downloads.resume("e2");
    await reaches(store, "complete");
  });

  it("asks again for a copy the server no longer knows of", async () => {
    const store = memoryVideoStore();
    const copy = { state: "queued" };
    const asked = server(copy);
    const downloads = new VideoDownloads(() => store);
    await downloads.enqueue([request], options);
    await reaches(store, "preparing");
    // A restart there, or a cleared cache: nothing known of it.
    copy.state = "none";
    asked.length = 0;
    const waiting = downloads.lookAtPreparing();
    copy.state = "running";
    await waiting;
    await waitFor(() => expect(asked.filter((call) => call.method === "PUT")).toHaveLength(1));
    await reaches(store, "preparing");
  });
});

describe("the quality suggested for a device", () => {
  it("is 480p for a phone and 720p for a tablet or a computer, within what is allowed", () => {
    expect(suggestedRung([1080, 720, 480], "phone")).toBe(480);
    expect(suggestedRung([1080, 720, 480], "tablet")).toBe(720);
    expect(suggestedRung([1080, 720, 480], "computer")).toBe(720);
    // Held to 480p away from home: that, on anything.
    expect(suggestedRung([480], "tablet")).toBe(480);
    // Only larger ones on offer: the smallest of them.
    expect(suggestedRung([1080], "phone")).toBe(1080);
    expect(suggestedRung([], "phone")).toBeNull();
  });
});

describe("downloading a film the browser plays as it is", () => {
  it("fetches the file in slices and puts it together again", async () => {
    const store = memoryVideoStore();
    const size = 20 * 1024 * 1024;
    mockApi.mockResolvedValue(playInfo({ mode: "direct", url: "/video/api/stream/e2" }));
    const ranges: string[] = [];
    fetchMock.mockImplementation(async (_url, init) => {
      const range = new Headers(init?.headers).get("Range")!;
      ranges.push(range);
      const [, from, to] = /bytes=(\d+)-(\d+)/.exec(range)!;
      const end = Math.min(Number(to), size - 1);
      return new Response(new Uint8Array(end - Number(from) + 1), {
        status: 206,
        headers: { "Content-Range": `bytes ${from}-${end}/${size}`, "Content-Type": "video/mp4" }
      });
    });
    const downloads = new VideoDownloads(() => store);
    await downloads.enqueue([request], options);
    await reaches(store, "complete");

    expect(ranges).toEqual(["bytes=0-8388607", "bytes=8388608-16777215", "bytes=16777216-25165823"]);
    expect(await store.get("e2")).toMatchObject({ kind: "file", totalBytes: size, downloadedBytes: size, totalParts: 3, mime: "video/mp4" });
    const parts = await store.getParts("e2");
    expect(parts.reduce((sum, part) => sum + part.size, 0)).toBe(size);
  });
});

describe("offlineHlsLoader", () => {
  it("answers hls.js with the playlist kept and each segment from the store", async () => {
    const store = memoryVideoStore();
    await store.putPart("e2", 1, new Blob(["second"]));
    const Loader = offlineHlsLoader(store, { id: "e2", playlist: PLAYLIST });
    const load = (url: string) => new Promise<unknown>((resolve, reject) => {
      const loader = new Loader({} as never);
      loader.load({ url, responseType: "" } as never, {} as never, {
        onSuccess: (response) => resolve(response.data),
        onError: (error) => reject(new Error(error.text)),
        onTimeout: () => reject(new Error("timeout"))
      });
    });
    expect(await load("http://localhost/video/offline/e2/index.m3u8")).toBe(PLAYLIST);
    const segment = await load("http://localhost/video/offline/e2/1.ts") as ArrayBuffer;
    expect(new TextDecoder().decode(segment)).toBe("second");
    await expect(load("http://localhost/video/offline/e2/7.ts")).rejects.toThrow("Not saved");
  });
});

describe("the player and a downloaded film", () => {
  const saved = (store: Store) => store.put({
    id: "e2",
    title: "Birds of a Feather",
    showTitle: "Counterpart",
    season: 1,
    episode: 2,
    parent: { kind: "shows", id: "s1" },
    quality: 720,
    posterUrl: null,
    kind: "hls",
    info: playInfo({ mode: "transcode", url: "/video/api/hls/e2/t1q720/index.m3u8", quality: { current: 720, allowed: [720], network: "internet" } }) as never,
    mime: null,
    playlist: PLAYLIST,
    subtitles: [],
    totalParts: 3,
    doneParts: 3,
    totalBytes: 30,
    estimatedBytes: 30,
    downloadedBytes: 30,
    state: "complete",
    problem: null,
    createdAt: "2026-11-10T00:00:00.000Z",
    queuedAt: 1,
    position: 9,
    duration: 16,
    watched: false,
    positionAt: 5,
    positionSynced: false
  });

  afterEach(() => videoDownloads.use(() => null));

  it("plays the copy on this device, from where it was left, with no word from the server", async () => {
    const store = memoryVideoStore();
    await saved(store);
    videoDownloads.use(() => store);
    // No connection: nothing is asked of the engine.
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    renderSignedIn(<VideoPlayerPage id="e2" />);

    expect(await screen.findByRole("heading", { name: "Counterpart" })).toBeInTheDocument();
    await waitFor(() => expect(hlsCalls.source).toMatch(/\/video\/offline\/e2\/index\.m3u8$/));
    // Read through the loader, from the place this device remembered.
    expect(hlsCalls.config).toMatchObject({ startPosition: 9 });
    expect(hlsCalls.config?.loader).toBeTypeOf("function");
    expect(mockApi).not.toHaveBeenCalled();
    // Back goes to what is on this device: the title's page needs the server.
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/downloads");
  });

  it("is only a finished download: one still on its way plays from the server", async () => {
    const store = memoryVideoStore();
    await saved(store);
    await store.patch("e2", { state: "downloading", doneParts: 1 });
    videoDownloads.use(() => store);
    expect(await getOfflineVideo("e2")).toBeNull();
  });
});
