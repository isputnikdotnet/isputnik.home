import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Applications › Videos › Settings, one page (2026-11-22): every setting is changed
// where it is shown — Disk and memory, Converting, Downloads and offline — and saves
// at once. Only lists open a page of their own: who is watching (?show=conversion),
// what is kept (?show=copies) and the queue (?show=jobs).

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});

const { api } = await import("../src/api");
const { VideoSettings } = await import("../src/features/control/sections/VideoSettingsSection");
const mockApi = vi.mocked(api);

const usage = { viewers: [{ user: "Mum", title: "Loud Film", mode: "transcode", converter: "gpu", converting: true, memoryBytes: 0, diskBytes: 0 }], memoryBytes: 0, diskBytes: 0 };
const kabyLake = { mode: "auto", device: "/dev/dri/renderD128", driver: "Intel iHD driver 24.1", encode: true, decode: ["h264", "hevc", "hevc10"], error: null, checking: false, setAside: false };
const state = (hardware: object | undefined, settings: object = {}) => ({
  available: true,
  settings: { memoryPerViewerMb: 300, maxViewers: 3, whenFull: "disk", ...(hardware ? { hardware: "auto" } : {}), ...settings },
  usage,
  ...(hardware ? { hardware } : {})
});
/** Engine 0.35+: one storage choice, one memory pool, and the disk as it found it. */
const newer = (mapped: boolean, settings: object = {}) => ({
  ...state(kabyLake, { storage: "memory-disk", memoryMb: 1024, memoryPerViewerMb: 341, ...settings }),
  disk: { mapped, folder: "/transcode", freeBytes: mapped ? 400 * 1024 ** 3 : null, totalBytes: mapped ? 500 * 1024 ** 3 : null },
  storage: mapped ? "memory-disk" : "memory"
});
const copiesState = {
  settings: { limitGb: 50 }, folder: "/transcode/copies", usedBytes: 2 * 1024 ** 3, copies: [], insideContainer: false,
  kept: [{ variant: "abc", title: "Loud Film", rung: 480, sizeBytes: 300 * 1024 * 1024, usedAt: "2026-11-12T10:00:00Z", inUse: true }],
  keptBytes: 300 * 1024 * 1024
};
const jobsState = {
  gate: { open: false, reason: "night" },
  settings: { when: "night", nightStart: "01:00", nightEnd: "07:00", atOnce: 1, perPerson: 10, remoteMbps: 0 },
  jobs: [
    { id: "keep:abc", kind: "keep", title: "Wide Film", quality: 720, state: "running", progress: 0.4, paused: false },
    { id: "copy:m1:480:1", kind: "copy", title: "Loud Film", quality: 480, state: "queued", progress: 0, paused: false }
  ]
};

interface Call { path: string; method: string; body?: string }
let calls: Call[] = [];

/** The engine's endpoints, each answering its own state; one left out answers as an
 *  engine too old for it does. `on` answers a write (by "METHOD path-ending"). */
function serve(parts: { conversion?: object; copies?: object; jobs?: object; keepReady?: object }, on: Record<string, () => object> = {}) {
  calls = [];
  mockApi.mockImplementation((async (path: string, options?: RequestInit) => {
    if (typeof path !== "string") return undefined;
    const method = options?.method ?? "GET";
    calls.push({ path, method, body: options?.body as string | undefined });
    const handler = Object.entries(on).find(([key]) => key.startsWith(`${method} `) && path.includes(key.slice(method.length + 1)));
    if (handler) return handler[1]();
    const part = path.includes("keep-ready") ? parts.keepReady
      : path.includes("/conversion") ? parts.conversion
      : path.includes("/copies") ? parts.copies
      : path.includes("/jobs") ? parts.jobs
      : undefined;
    if (!part) throw new Error("not here");
    return part;
  }) as never);
}
const page = (show: "conversion" | "copies" | "jobs" | null = null) => render(<VideoSettings prefix="/video" page={show} go={() => undefined} />);
const card = async (name: string) => screen.findByRole("region", { name });
const puts = () => calls.filter((call) => call.method === "PUT");

beforeEach(() => mockApi.mockReset());

describe("converting", () => {
  it("says what the GPU does on the page, and who it converts for on the list", async () => {
    serve({ conversion: state(kabyLake) });
    page();
    // Every conversion setting is in the one card: Hardware & transcoding.
    const converting = await card("Hardware & transcoding");
    expect(screen.queryByRole("region", { name: "Converting" })).toBeNull();
    expect(within(converting).getByRole("region", { name: "Hardware" })).toBeInTheDocument();
    expect(within(within(converting).getByRole("region", { name: "Limits" })).getByLabelText("Viewers at once")).toHaveValue(3);
    expect(within(converting).getByText("Converting on the GPU")).toBeInTheDocument();
    expect(within(converting).getByText(/HEVC 10-bit/)).toBeInTheDocument();
    expect(within(converting).getByText(/\/dev\/dri\/renderD128 · Intel iHD driver 24\.1/)).toBeInTheDocument();
    // Who is watching is a list: one click away, from the card's head.
    expect(within(converting).getByRole("button", { name: /^Watching now.*1 of 3/ })).toBeInTheDocument();
    expect(screen.queryByText(/· GPU/)).toBeNull();
    cleanup();

    page("conversion");
    expect(await screen.findByText(/· GPU/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Where to convert")).toBeNull();
  });

  it("says whether HDR is tone-mapped and subtitles drawn on the GPU, and marks HDR films (engine 0.25+)", async () => {
    const hdrUsage = { ...usage, viewers: [{ ...usage.viewers[0], title: "Bright Night", hdr: true }] };
    serve({ conversion: { ...state({ ...kabyLake, tonemap: false, overlay: true }), usage: hdrUsage } });
    page();
    expect(await screen.findByText(/HDR films are tone-mapped to normal colours on the CPU/)).toBeInTheDocument();
    expect(screen.getByText(/Draws picture subtitles \(Blu-ray, DVD\) on the GPU/)).toBeInTheDocument();
    cleanup();
    page("conversion");
    expect(await screen.findByText(/· GPU · HDR/)).toBeInTheDocument();
  });

  it("checks again on asking, and saves where to convert and how many at once", async () => {
    serve({ conversion: state(kabyLake) }, {
      "POST /conversion/check": () => state({ ...kabyLake, encode: false, decode: [], error: "No GPU: /dev/dri is not passed to the container" })
    });
    page();
    await userEvent.click(await screen.findByRole("button", { name: "Check again" }));
    expect(await screen.findByText("No GPU: /dev/dri is not passed to the container")).toBeInTheDocument();
    expect(calls.some((call) => call.method === "POST" && call.path === "/video/api/admin/conversion/check")).toBe(true);

    await userEvent.selectOptions(screen.getByLabelText("Where to convert"), "cpu");
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(JSON.parse(puts()[0]!.body!)).toMatchObject({ hardware: "cpu" });

    const viewers = screen.getByLabelText("Viewers at once");
    await userEvent.clear(viewers);
    await userEvent.type(viewers, "5{Enter}");
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(JSON.parse(puts()[1]!.body!)).toMatchObject({ maxViewers: 5 });
  });

  it("says what the hardware test found beside the limit it is about, and takes it on asking", async () => {
    const tested = (suggestedViewers: number) => ({ running: null, available: true, last: { id: 1, startedAt: "2026-11-15T18:41:00Z", finishedAt: "2026-11-15T18:50:00Z", phase: "done", doing: null, reason: null, scenarios: [], together: [], suggestedViewers } });
    serve({ conversion: state(kabyLake) }, { "GET /hardware/test": () => tested(5) });
    page();
    const limits = await screen.findByRole("region", { name: "Limits" });
    expect(await within(limits).findByText("The hardware test suggests 5")).toBeInTheDocument();
    await userEvent.click(within(limits).getByRole("button", { name: "Use 5" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(JSON.parse(puts()[0]!.body!)).toMatchObject({ maxViewers: 5 });
    cleanup();

    // The limit already is what the test found: said so, with nothing to press.
    serve({ conversion: state(kabyLake) }, { "GET /hardware/test": () => tested(3) });
    page();
    const same = await screen.findByRole("region", { name: "Limits" });
    expect(await within(same).findByText("Matches the hardware test: 3 at once")).toBeInTheDocument();
    expect(within(same).queryByRole("button", { name: /^Use / })).toBeNull();
    // Activity, Tasks and Logs are the Overview's: no side menu on this tab.
    expect(screen.queryByRole("region", { name: "Activity & diagnostics" })).toBeNull();
  });

  it("takes what it converts and what it advises from the hardware test, and says to run one first", async () => {
    const run = (speed: number, verdict: string) => ({ speed, fps: speed * 24, verdict, error: null });
    const done = {
      id: 7, startedAt: "2026-11-15T18:41:00Z", finishedAt: "2026-11-15T18:50:00Z", phase: "done", doing: null, reason: null, together: [], suggestedViewers: 5,
      scenarios: [
        { id: "4k-hdr", label: "4K HDR", skipped: null, gpuRun: run(3.1, "smooth"), cpuRun: run(0.4, "slow") },
        { id: "divx", label: "DivX", skipped: null, gpuRun: null, cpuRun: run(1.2, "tight") },
        { id: "av1", label: "AV1", skipped: null, gpuRun: null, cpuRun: run(0.6, "slow") }
      ]
    };
    // No test has run: nothing is claimed, and it says what to do.
    const opened: (string | null)[] = [];
    serve({ conversion: state(kabyLake) }, {
      "POST /hardware/test": () => ({ test: { ...done, phase: "converting", finishedAt: null } }),
      "GET /hardware/test": () => ({ running: null, last: null, available: true })
    });
    render(<VideoSettings prefix="/video" page={null} go={(next) => opened.push(next)} />);
    const bare = await card("Hardware & transcoding");
    expect(await within(bare).findByText(/^Run the test first/)).toBeInTheDocument();
    expect(within(bare).queryByRole("list", { name: "Converts fast enough" })).toBeNull();
    expect(within(bare).queryByRole("button", { name: /Test results/ })).toBeNull();
    expect(within(within(bare).getByRole("region", { name: "Recommended settings" })).getByText("Run the test to see what it recommends.")).toBeInTheDocument();
    // Run test is at the top of the card: started here, followed on its own page.
    await userEvent.click(within(bare).getByRole("button", { name: "Run test" }));
    await waitFor(() => expect(opened).toEqual(["hardware"]));
    expect(calls.some((call) => call.method === "POST" && call.path === "/video/api/admin/hardware/test")).toBe(true);
    cleanup();

    // A test has run: only what came out fast enough is listed, lit, with where it ran.
    serve({ conversion: state(kabyLake) }, { "GET /hardware/test": () => ({ running: null, last: done, available: true }) });
    page();
    const hardware = await card("Hardware & transcoding");
    const formats = await within(hardware).findByRole("list", { name: "Converts fast enough" });
    expect(within(formats).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["4K HDR", "DivX / XviD"]);
    expect(within(formats).getByText("4K HDR").closest("li")).toHaveAttribute("title", "On the GPU");
    expect(within(formats).getByText("DivX / XviD").closest("li")).toHaveAttribute("title", "On the CPU");
    expect(within(hardware).getByRole("button", { name: /Test results/ })).toBeInTheDocument();
    // And what it advises for the settings beside it, with how they stand.
    const advice = within(hardware).getByRole("region", { name: "Recommended settings" });
    expect(within(advice).getByText("Convert on the GPU")).toBeInTheDocument();
    expect(within(advice).getByText("5 viewers at once")).toBeInTheDocument();
    expect(within(advice).getByText("Now set to 3")).toBeInTheDocument();
  });

  it("saves the quality for viewers away from home, and marks each viewer's rung (engine 0.31+)", async () => {
    const rungUsage = { ...usage, viewers: [{ ...usage.viewers[0], rung: 720 }] };
    serve({ conversion: { ...state(kabyLake, { remoteQuality: 720 }), usage: rungUsage } });
    page();
    const field = await screen.findByLabelText("Quality away from home");
    expect(field).toHaveValue("720");
    await userEvent.selectOptions(field, "original");
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(JSON.parse(puts()[0]!.body!)).toMatchObject({ remoteQuality: null });
    cleanup();
    page("conversion");
    expect(await screen.findByText(/· GPU · 720p/)).toBeInTheDocument();
  });

  it("offers an engine from before the GPU and the storage choice only what it has", async () => {
    serve({ conversion: state(undefined) });
    page();
    expect(await screen.findByLabelText("Viewers at once")).toBeInTheDocument();
    expect(screen.getByLabelText("Memory per viewer (MB)")).toHaveValue(300);
    expect(screen.queryByLabelText("Where to convert")).toBeNull();
    expect(screen.queryByLabelText("Quality away from home")).toBeNull();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Disk & memory" })).toBeNull();
  });
});

describe("disk and memory (engine 0.35+)", () => {
  const memoryField = (disk: HTMLElement) => within(disk).getByRole("spinbutton", { name: "Memory for conversion" });
  const keep = (disk: HTMLElement) => within(disk).getByRole("group", { name: "Keep converted video" });

  it("shows the cache on one line, and saves where video is kept and the memory in the new words alone", async () => {
    serve({ conversion: newer(true) });
    page();
    const disk = await card("Disk & memory");
    expect(within(disk).getByText("Video cache (transcodes and downloads)")).toBeInTheDocument();
    expect(within(disk).getByText("/transcode")).toBeInTheDocument();
    expect(within(disk).getByText(/400(\.0)? GB free on this disk/)).toBeInTheDocument();
    // Two ways, not three: on disk is memory first, then the disk.
    expect(within(keep(disk)).getByRole("button", { name: "On disk (cache)" })).toHaveAttribute("aria-pressed", "true");
    // One pool, not memory per viewer.
    expect(memoryField(disk)).toHaveValue(1024);
    expect(screen.queryByLabelText("Memory per viewer (MB)")).toBeNull();

    await userEvent.click(within(keep(disk)).getByRole("button", { name: "In memory only" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    const body = JSON.parse(puts()[0]!.body!);
    expect(body).toMatchObject({ storage: "memory", memoryMb: 1024 });
    expect(body).not.toHaveProperty("memoryPerViewerMb");
    expect(body).not.toHaveProperty("whenFull");

    // The number beside the slider is typed for an exact amount, and saved on leaving it.
    await userEvent.clear(memoryField(disk));
    await userEvent.type(memoryField(disk), "2048{Enter}");
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(JSON.parse(puts()[1]!.body!)).toMatchObject({ memoryMb: 2048 });
  });

  it("says there is no disk, keeps to memory only, and links to setting one up", async () => {
    serve({ conversion: newer(false) });
    page();
    const disk = await card("Disk & memory");
    expect(within(disk).getByText("No disk for video")).toBeInTheDocument();
    expect(within(keep(disk)).getByRole("button", { name: "In memory only" })).toHaveAttribute("aria-pressed", "true");
    expect(within(keep(disk)).getByRole("button", { name: "On disk (cache)" })).toBeDisabled();
    // A video container too old to choose a folder here: the guide says how.
    const guide = within(disk).getByRole("link", { name: "Set up a disk for video" });
    expect(guide.getAttribute("href")).toMatch(/^\/help\/.+#where-converted-video-is-kept$/);
    // The hardware card says so too.
    expect(screen.getAllByText("Not set up").length).toBeGreaterThan(0);
  });

  it("chooses the folder for video as Add library chooses one: a location, then its folders (engine 0.42+)", async () => {
    const withChoice = (choice: object, mapped = false) => {
      const base = newer(mapped);
      return { ...base, disk: { ...base.disk, choice } };
    };
    // A location's folders, by the address asked for.
    const browse = () => {
      const asked = new URL(calls[calls.length - 1]!.path, "http://x");
      const place = asked.searchParams.get("place")!;
      const at = asked.searchParams.get("path") ?? "";
      const base = place === "cache" ? "/transcode" : "/media";
      return {
        root: { id: place, name: base }, currentPath: at, selectedPath: at ? `${base}/${at}` : base, parentPath: at ? "" : null,
        entries: at ? [] : [{ name: place === "cache" ? "films" : "Movies", relativePath: place === "cache" ? "films" : "Movies" }]
      };
    };
    serve({ conversion: withChoice({ folder: null, pending: false, problem: null }) }, {
      "GET /conversion/folders/browse": browse,
      "GET /conversion/folders": () => ({
        places: [
          { id: "libraries", kind: "libraries", path: "/media", writable: false },
          { id: "cache", kind: "cache", path: "/transcode", writable: true }
        ],
        subfolder: "video-cache", choice: { folder: null, pending: false, problem: null }, container: null
      }),
      "PUT /conversion/folder": () => withChoice({ folder: "/transcode/films", pending: true, problem: null })
    });
    page();
    const disk = await card("Disk & memory");
    // No trip to the guide: the folder is chosen on the card itself.
    expect(within(disk).queryByRole("link", { name: "Set up a disk for video" })).toBeNull();
    await userEvent.click(within(disk).getByRole("button", { name: "Choose folder" }));

    // Two locations, named for what they are; it opens on the cache folder.
    const dialog = await screen.findByRole("dialog", { name: "Folder for video" });
    const location = await within(dialog).findByLabelText("Location");
    expect(within(location).getAllByRole("option").map((option) => option.textContent)).toEqual(["Libraries folder (/media)", "Cache folder (/transcode)"]);
    expect(location).toHaveValue("cache");
    // One line of words, not a page of them.
    expect(within(dialog).getByText("Where converted video and downloads are kept.")).toBeInTheDocument();
    expect(within(dialog).queryByText(/Restart the video container/)).toBeNull();

    // Where the container may only read, nothing can be picked, and it says why.
    await userEvent.selectOptions(location, "libraries");
    expect(await within(dialog).findByText("The video container can only read this location")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Use this folder" })).toBeDisabled();

    // Into the cache folder, down one folder, and that one is used.
    await userEvent.selectOptions(location, "cache");
    await userEvent.click(await within(dialog).findByRole("button", { name: "films" }));
    expect(await within(dialog).findByText("/transcode/films")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Use this folder" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]).toMatchObject({ path: "/video/api/admin/conversion/folder", body: JSON.stringify({ folder: "/transcode/films" }) });

    // The card says what the dialog no longer has to: it waits for a restart.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(disk).getByText("Restart the video container to use the new folder")).toBeInTheDocument();
    expect(within(disk).getByText(/Chosen: \/transcode\/films\./)).toBeInTheDocument();
  });

  it("opens on how video plays and the hardware that converts it", async () => {
    const memory = { at: "2026-11-22T10:00:00Z", cpu: { percent: 3, cores: 4, load: null, model: "Intel(R) Core(TM) i5-7500 CPU @ 3.40GHz" }, memory: { totalBytes: 16 * 1024 ** 3, availableBytes: 7 * 1024 ** 3, homeBytes: 0 } };
    serve({ conversion: newer(true), copies: copiesState }, { "GET /api/admin/diagnostics/now": () => memory });
    page();
    // How: two questions (can the device play it? is a version kept?) and three ways.
    const how = await card("How video plays");
    expect(within(how).getByText("Direct Play")).toBeInTheDocument();
    expect(within(how).getByText("Transcode")).toBeInTheDocument();
    expect(within(how).getByText("Can your device play it as is?")).toBeInTheDocument();
    expect(within(how).getByText("Have a cached version?")).toBeInTheDocument();
    expect(await within(how).findByText("Convert to a supported format (on the GPU)")).toBeInTheDocument();
    expect(within(how).getByRole("link", { name: "Learn more" }).getAttribute("href")).toMatch(/^\/help\/.+#converting-video$/);
    // With a disk for video in use, what was converted once is played from the cache.
    expect(within(how).getByText("From cache")).toBeInTheDocument();
    expect(within(how).getByText("Use a prepared copy · Fast start")).toBeInTheDocument();

    // What with: the GPU in use, the CPU by name, the server's memory, the disk for video.
    const hardware = await card("Hardware & transcoding");
    expect(within(hardware).getByText("Intel graphics")).toBeInTheDocument();
    expect(within(hardware).getAllByText("Active")).toHaveLength(2);
    expect(await within(hardware).findByText("Intel(R) Core(TM) i5-7500 CPU @ 3.40GHz")).toBeInTheDocument();
    expect(within(hardware).getByText("9.00 GB / 16.0 GB")).toBeInTheDocument();
    expect(await within(hardware).findByText("2.29 GB / 50 GB")).toBeInTheDocument();
    // The cards of numbers they replaced are gone.
    expect(screen.queryByRole("region", { name: "At a glance" })).toBeNull();
    cleanup();

    // No GPU and no disk: converted on the CPU, and the disk says it is not set up.
    serve({ conversion: { ...newer(false), hardware: { ...kabyLake, encode: false, decode: [], device: null } } });
    page();
    expect(await within(await card("How video plays")).findByText("Convert to a supported format (on the CPU)")).toBeInTheDocument();
    expect(within(await card("How video plays")).getByText("Off: no disk for video")).toBeInTheDocument();
    const bare = await card("Hardware & transcoding");
    expect(within(bare).getByText("No GPU in use")).toBeInTheDocument();
    expect(within(bare).getByText("Not found")).toBeInTheDocument();
    expect(within(bare).getByText("Not set up")).toBeInTheDocument();
  });

  it("sets the room and the retention, says what the room holds, and asks before anything is deleted", async () => {
    const kept = { ...copiesState, settings: { limitGb: 50, retentionDays: 0 } };
    serve({ conversion: newer(true), copies: kept }, { "PUT /copies": () => kept });
    page();
    const disk = await card("Disk & memory");
    const room = await within(disk).findByRole("spinbutton", { name: "Disk space for kept video (cache)" });
    expect(room).toHaveValue(50);
    // How full, on the cache's own line, and what it is made of.
    expect(within(disk).getByText("2.29 GB of 50 GB (5%)")).toBeInTheDocument();
    expect(within(disk).getByRole("meter", { name: /^Room for kept video: 2\.29 GB of 50 GB used$/ })).toHaveAttribute("aria-valuenow", "5");
    expect(within(disk).getByText(/Cached videos/)).toHaveTextContent(/300(\.0)? MB/);
    expect(within(disk).getByText(/^Downloads/)).toHaveTextContent("2.00 GB");
    expect(within(disk).getByText(/Left of 50 GB/)).toHaveTextContent(/47\.\d GB/);

    // More room: saved at once.
    await userEvent.clear(room);
    await userEvent.type(room, "80{Enter}");
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]).toMatchObject({ path: "/video/api/admin/copies", body: JSON.stringify({ limitGb: 80 }) });

    // Less than is kept deletes the oldest of it: asked first, saying how much.
    await userEvent.clear(room);
    await userEvent.type(room, "1{Enter}");
    const shrink = await screen.findByRole("alertdialog", { name: "Reduce the room for kept video to 1 GB?" });
    expect(within(shrink).getByText(/About 1\.29 GB of it/)).toBeInTheDocument();
    expect(puts()).toHaveLength(1);
    await userEvent.click(within(shrink).getByRole("button", { name: "Remove kept video" }));
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts()[1]!.body).toBe(JSON.stringify({ limitGb: 1 }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    // Retention: kept until the room runs out to start with; a time deletes what is older, so it asks.
    const retention = within(disk).getByLabelText("Retention");
    expect(retention).toHaveValue("0");
    await userEvent.selectOptions(retention, "30");
    const ask = await screen.findByRole("alertdialog", { name: "Remove kept video unused for 30 days?" });
    await userEvent.click(within(ask).getByRole("button", { name: "Remove kept video" }));
    await waitFor(() => expect(puts()).toHaveLength(3));
    expect(puts()[2]!.body).toBe(JSON.stringify({ retentionDays: 30 }));
  });
});

describe("films kept after watching (engine 0.35+)", () => {
  it("lists them beside the copies and the titles kept ready, and says who shares a version", async () => {
    const keepReady = { available: true, titles: [{ id: "movie:m1", kind: "movie", targetId: "m1", season: null, rungs: [720], newEpisodes: true, title: "Quiet Film", total: 1, ready: 1, asIs: 0, waiting: 0, missing: 0, sizeBytes: 0, estimateBytes: 0, making: null }] };
    serve({ copies: copiesState, keepReady });
    page("copies");
    expect(await screen.findByText("Kept after watching")).toBeInTheDocument();
    expect(screen.getByText(/^1 film kept, 300(\.0)? MB\.$/)).toBeInTheDocument();
    expect(screen.getByText("480p · watching now")).toBeInTheDocument();
    // The room is set on the page itself, not on this list.
    expect(screen.queryByLabelText("Room for kept video, GB")).toBeNull();
    expect(screen.getByRole("button", { name: "Remove copies and kept films" })).toBeInTheDocument();
    // The titles kept ready, each a link to its page.
    expect(await screen.findByRole("link", { name: /Quiet Film/ })).toHaveAttribute("href", "/movies/m1");
    cleanup();

    const sharedUsage = { viewers: [{ ...usage.viewers[0], shared: true }, { ...usage.viewers[0], user: "Dad", shared: true }], memoryBytes: 0, diskBytes: 0, kept: { count: 2, bytes: 0 } };
    serve({ conversion: { ...state(kabyLake), usage: sharedUsage } });
    page("conversion");
    expect(await screen.findAllByText(/watched together/)).toHaveLength(2);
    expect(screen.getByText("Films kept whole")).toBeInTheDocument();
  });
});

describe("downloads and offline (engine 0.35+)", () => {
  it("opens on how a download is prepared, what the queue is doing, and the rules", async () => {
    const opened: (string | null)[] = [];
    const tested = { running: null, available: true, last: { id: 1, startedAt: "2026-11-15T18:41:00Z", finishedAt: "2026-11-15T18:50:00Z", phase: "done", doing: null, reason: null, scenarios: [], together: [], suggestedViewers: 3 } };
    const keepReady = { available: true, titles: [{ id: "movie:m1", kind: "movie", targetId: "m1", season: null, rungs: [720], newEpisodes: true, title: "Quiet Film", total: 1, ready: 1, asIs: 0, waiting: 0, missing: 0, sizeBytes: 1024 ** 3, estimateBytes: 0, making: null }] };
    serve({ conversion: newer(true), copies: copiesState, jobs: jobsState, keepReady }, {
      "GET /hardware/test": () => tested,
      "PUT /jobs": () => ({ ...jobsState, settings: { ...jobsState.settings, when: "idle" } })
    });
    // Video Streaming has no downloads on it: they are the other tab.
    page();
    await card("Hardware & transcoding");
    expect(screen.queryByRole("region", { name: "Download rules" })).toBeNull();
    cleanup();

    render(<VideoSettings tab="downloads" prefix="/video" page={null} go={(next) => opened.push(next)} />);
    // How: the original file, a kept copy, or one prepared in the queue.
    const how = await card("How downloads work");
    expect(within(how).getByText("Original file asked for?")).toBeInTheDocument();
    expect(within(how).getByText("Is a copy already kept?")).toBeInTheDocument();
    expect(await within(how).findByText("Joins the queue, then downloads")).toBeInTheDocument();
    expect(within(how).getByRole("link", { name: "Learn more" }).getAttribute("href")).toMatch(/^\/help\/.+#copies-for-download$/);

    // What: the queue, the copies, what is kept ready, and the room, in one row.
    const status = await card("Queue and kept copies");
    expect(await within(status).findByText("1 making · 1 waiting")).toBeInTheDocument();
    expect(within(status).getByText("Waiting for the night")).toBeInTheDocument();
    expect(await within(status).findByText("1 title")).toBeInTheDocument();
    expect(within(status).getByText("2.29 GB / 50 GB")).toBeInTheDocument();
    // The room is set beside the disk, on Video Streaming.
    expect(within(status).getByRole("link", { name: "Set on Video Streaming" })).toHaveAttribute("href", "/control/apps/videos/streaming#video-conversion-storage");
    // The next few jobs, and the two lists a press away.
    const next = within(status).getByRole("region", { name: "Next up" });
    expect(within(next).getByText("Wide Film")).toBeInTheDocument();
    expect(within(next).getByText("720p · making, 40%")).toBeInTheDocument();
    await userEvent.click(within(status).getByRole("button", { name: "Open queue" }));
    await userEvent.click(within(status).getByRole("button", { name: "Kept copies" }));
    expect(opened).toEqual(["jobs", "copies"]);

    // The rules, saved as they change — and what the hardware test found for jobs at once.
    const rules = await card("Download rules");
    expect(within(rules).getByLabelText("Prepare")).toHaveValue("night");
    expect(within(rules).getByLabelText("Jobs at once")).toHaveValue(1);
    expect(within(rules).getByText("The hardware test managed 3 at once")).toBeInTheDocument();
    // A plain number box: no button naming a number, no steps.
    expect(within(rules).queryByRole("button", { name: /^Use / })).toBeNull();
    expect(within(rules).queryByRole("button", { name: /jobs at once/ })).toBeNull();
    expect(screen.queryByLabelText("Where to convert")).toBeNull();
    await userEvent.selectOptions(within(rules).getByLabelText("Prepare"), "idle");
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(JSON.parse(puts()[0]!.body!)).toEqual({ when: "idle" });
    await userEvent.clear(within(rules).getByLabelText("Jobs at once"));
    await userEvent.type(within(rules).getByLabelText("Jobs at once"), "2{Enter}");
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(JSON.parse(puts()[1]!.body!)).toEqual({ atOnce: 2 });
    cleanup();

    // No disk for video: nothing is kept or prepared ahead, and the flow says so.
    serve({ conversion: newer(false), copies: { ...copiesState, insideContainer: true }, jobs: jobsState });
    render(<VideoSettings tab="downloads" prefix="/video" page={null} go={() => undefined} />);
    const bare = await card("How downloads work");
    expect(await within(bare).findByText("Converted as it downloads")).toBeInTheDocument();
    expect(within(bare).getByText("Off: no disk for video")).toBeInTheDocument();
  });

  it("lists what runs and waits, and runs a waiting one now", async () => {
    serve({ jobs: jobsState }, { "POST /jobs/run": () => jobsState });
    page("jobs");
    expect(await screen.findByText("kept ready · 720p · making, 40%")).toBeInTheDocument();
    expect(screen.getByText("copy for download · 480p · waiting")).toBeInTheDocument();
    expect(screen.getByText("Waiting for the night: nothing new starts until then.")).toBeInTheDocument();
    // The rule itself is set on the page, not here.
    expect(screen.queryByLabelText("Prepare")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Actions for Loud Film" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Run now" }));
    await waitFor(() => expect(calls.find((call) => call.method === "POST")).toBeDefined());
    expect(calls.find((call) => call.method === "POST")).toMatchObject({ path: "/video/api/admin/jobs/run", body: JSON.stringify({ id: "copy:m1:480:1" }) });
  });
});
