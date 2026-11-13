import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HardwareTestPage, type DiskCheck, type HardwareTest } from "../src/features/control/sections/VideoHardwareTest";

vi.mock("../src/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/api")>()), api: vi.fn() }));
const { api, ApiError } = await import("../src/api");
const mockApi = vi.mocked(api);

// Videos › Settings › Hardware test (docs/video-hardware-tests-plan.md, phase 2):
// the engine's results worded on the page, the limit it suggests, and an engine
// too old to have the test.
const run = (speed: number, verdict: "smooth" | "tight" | "slow") => ({ speed, fps: speed * 24, verdict, error: null });
const done: HardwareTest = {
  id: 7, startedAt: "2026-11-13T07:37:00.000Z", finishedAt: "2026-11-13T07:40:00.000Z", phase: "done", doing: null, step: null, reason: null,
  scenarios: [
    { id: "4k-hdr", label: "4K HDR", skipped: null, gpuRun: run(2.4, "smooth"), cpuRun: run(0.9, "slow") },
    { id: "av1", label: "AV1", skipped: "This ffmpeg can't make the clip: Unknown encoder", gpuRun: null, cpuRun: null }
  ],
  together: [{ id: "4k-hdr", label: "4K HDR", converter: "gpu", atOnce: 2, atLeast: false }, { id: "1080p-hevc", label: "1080p", converter: "gpu", atOnce: 4, atLeast: true }],
  suggestedViewers: 2
};

const disks: DiskCheck = {
  id: 3, startedAt: "2026-11-13T08:00:00.000Z", phase: "done", step: null, reason: null,
  libraries: [
    { libraryId: "a", name: "Films", wake: { samples: [9200, 40], slowestMs: 9200, asleep: true }, read: { file: "Films/x.mkv", bytes: 536870912, seconds: 4, mbitPerSecond: 1073.7 }, heaviestMbit: 75, verdict: "plenty", error: null },
    { libraryId: "b", name: "4K remuxes", wake: { samples: [30], slowestMs: 30, asleep: false }, read: { file: "4K/y.mkv", bytes: 536870912, seconds: 80, mbitPerSecond: 53.7 }, heaviestMbit: 80, verdict: "short", error: null }
  ]
};

function answer(test: HardwareTest | null, changes: { id: number; at: string; summary: string }[] = [], diskCheck: DiskCheck | null = null) {
  mockApi.mockImplementation(async (url: string) => {
    if (url.endsWith("/hardware/history")) return { tests: test ? [test] : [], changes };
    if (url.endsWith("/hardware/disks")) return { running: null, last: diskCheck };
    return { running: null, last: test, available: true };
  });
}

beforeEach(() => { mockApi.mockReset(); });

describe("HardwareTestPage", () => {
  it("words each kind of film's speed and verdict, the skipped one, and how many at once", async () => {
    answer(done);
    render(<HardwareTestPage prefix="/video" capabilities={null} maxViewers={3} saving={false} onUseLimit={() => undefined} />);
    expect(await screen.findByText("4K HDR (HEVC 10-bit) to 1080p")).toBeInTheDocument();
    expect(screen.getByText("2.4× · smooth")).toBeInTheDocument();
    expect(screen.getByText("0.9× · too slow")).toBeInTheDocument();
    expect(screen.getByText(/Skipped: This ffmpeg can't make the clip/)).toBeInTheDocument();
    expect(screen.getByText("2 viewers")).toBeInTheDocument();
    expect(screen.getByText("4 or more")).toBeInTheDocument();
  });

  it("suggests the limit the results allow, and sets it only when asked", async () => {
    answer(done);
    const onUseLimit = vi.fn();
    render(<HardwareTestPage prefix="/video" capabilities={null} maxViewers={3} saving={false} onUseLimit={onUseLimit} />);
    expect(await screen.findByText("The results allow 2 people at once")).toBeInTheDocument();
    expect(onUseLimit).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Use 2" }));
    expect(onUseLimit).toHaveBeenCalledWith(2);
  });

  it("says when the hardware changed after the last test", async () => {
    answer(done, [{ id: 1, at: "2026-11-14T08:00:00.000Z", summary: "driver 24.1 → 25.2" }]);
    render(<HardwareTestPage prefix="/video" capabilities={null} maxViewers={3} saving={false} onUseLimit={() => undefined} />);
    expect(await screen.findByText("The hardware changed since the last test")).toBeInTheDocument();
    expect(screen.getByText(/driver 24\.1 → 25\.2\. Run the test again/)).toBeInTheDocument();
  });

  it("tells someone why it won't start while a person is watching", async () => {
    answer(null);
    mockApi.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") throw new ApiError("Someone is watching", 409, { code: "watching" });
      if (url.endsWith("/hardware/history")) return { tests: [], changes: [] };
      return { running: null, last: null, available: true };
    });
    render(<HardwareTestPage prefix="/video" capabilities={null} maxViewers={3} saving={false} onUseLimit={() => undefined} />);
    await userEvent.click(await screen.findByRole("button", { name: "Run test" }));
    expect(await screen.findByText("Someone is watching converted video. Try again when they've finished.")).toBeInTheDocument();
  });

  it("shows each library's disks: a sleeping one, and one too slow for its heaviest film", async () => {
    answer(done, [], disks);
    render(<HardwareTestPage prefix="/video" capabilities={null} maxViewers={3} saving={false} onUseLimit={() => undefined} />);
    expect(await screen.findByText("Films")).toBeInTheDocument();
    expect(screen.getByText(/First answer 9,200 ms at the slowest \(a disk was asleep\) · reads 1,074 Mbit\/s · its heaviest film needs 75 Mbit\/s/)).toBeInTheDocument();
    expect(screen.getByText("Plenty")).toBeInTheDocument();
    expect(screen.getByText("Too slow")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check disks" })).toBeInTheDocument();
  });

  it("asks for a newer video container when the engine has no test", async () => {
    mockApi.mockRejectedValue(new ApiError("Not found", 404));
    render(<HardwareTestPage prefix="/video" capabilities={null} maxViewers={3} saving={false} onUseLimit={() => undefined} />);
    expect(await screen.findByText("Needs a newer video container")).toBeInTheDocument();
  });
});
