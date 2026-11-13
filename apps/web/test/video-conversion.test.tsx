import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Applications › Videos › Settings: the Converting video page — what the engine found
// the GPU does (isputnik.video 0.20+, hardware.ts), Check again, where to convert —
// and the overview, where the quality away from home is chosen. Changes save at once.

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

beforeEach(() => mockApi.mockReset());

describe("converting on the GPU", () => {
  it("says what the GPU does and who it converts for", async () => {
    mockApi.mockResolvedValue(state(kabyLake) as never);
    render(<VideoSettings prefix="/video" page="conversion" go={() => undefined} />);
    expect(await screen.findByText("Converting on the GPU")).toBeInTheDocument();
    expect(screen.getByText(/HEVC 10-bit/)).toBeInTheDocument();
    expect(screen.getByText(/\/dev\/dri\/renderD128 · Intel iHD driver 24\.1/)).toBeInTheDocument();
    expect(screen.getByText(/· GPU/)).toBeInTheDocument();
  });

  it("says whether HDR is tone-mapped and subtitles drawn on the GPU, and marks HDR films (engine 0.25+)", async () => {
    const hdrUsage = { ...usage, viewers: [{ ...usage.viewers[0], title: "Bright Night", hdr: true }] };
    mockApi.mockResolvedValue({ ...state({ ...kabyLake, tonemap: false, overlay: true }), usage: hdrUsage } as never);
    render(<VideoSettings prefix="/video" page="conversion" go={() => undefined} />);
    expect(await screen.findByText(/HDR films are tone-mapped to normal colours on the CPU/)).toBeInTheDocument();
    expect(screen.getByText(/Draws picture subtitles \(Blu-ray, DVD\) on the GPU/)).toBeInTheDocument();
    expect(screen.getByText(/· GPU · HDR/)).toBeInTheDocument();
  });

  it("checks again on asking, and saves where to convert", async () => {
    const calls: { path: string; method: string; body?: string }[] = [];
    mockApi.mockImplementation((async (path: string, options?: RequestInit) => {
      calls.push({ path, method: options?.method ?? "GET", body: options?.body as string | undefined });
      if (options?.method === "POST") return state({ ...kabyLake, encode: false, decode: [], error: "No GPU: /dev/dri is not passed to the container" });
      return state(kabyLake);
    }) as never);
    render(<VideoSettings prefix="/video" page="conversion" go={() => undefined} />);
    await userEvent.click(await screen.findByRole("button", { name: "Check again" }));
    expect(await screen.findByText("No GPU: /dev/dri is not passed to the container")).toBeInTheDocument();
    expect(calls.some((call) => call.method === "POST" && call.path === "/video/api/admin/conversion/check")).toBe(true);

    await userEvent.selectOptions(screen.getByLabelText("Where to convert"), "cpu");
    await waitFor(() => expect(calls.find((call) => call.method === "PUT")).toBeDefined());
    expect(JSON.parse(calls.find((call) => call.method === "PUT")!.body!)).toMatchObject({ hardware: "cpu" });
  });

  it("saves the quality for viewers away from home, and marks each viewer's rung (engine 0.31+)", async () => {
    const calls: { method: string; body?: string }[] = [];
    const rungUsage = { ...usage, viewers: [{ ...usage.viewers[0], rung: 720 }] };
    mockApi.mockImplementation((async (_path: string, options?: RequestInit) => {
      calls.push({ method: options?.method ?? "GET", body: options?.body as string | undefined });
      return { ...state(kabyLake, { remoteQuality: 720 }), usage: rungUsage };
    }) as never);
    render(<VideoSettings prefix="/video" page="conversion" go={() => undefined} />);
    expect(await screen.findByText(/· GPU · 720p/)).toBeInTheDocument();
    cleanup();
    // The quality is chosen on the overview, and saved as it is chosen.
    render(<VideoSettings prefix="/video" page={null} go={() => undefined} />);
    const field = await screen.findByLabelText("Quality away from home");
    expect(field).toHaveValue("720");
    await userEvent.selectOptions(field, "original");
    await waitFor(() => expect(calls.find((call) => call.method === "PUT")).toBeDefined());
    expect(JSON.parse(calls.find((call) => call.method === "PUT")!.body!)).toMatchObject({ remoteQuality: null });
  });

  it("offers no GPU setting to an engine from before it had one", async () => {
    mockApi.mockResolvedValue(state(undefined) as never);
    render(<VideoSettings prefix="/video" page="conversion" go={() => undefined} />);
    expect(await screen.findByLabelText("People watching converted video at once", { exact: false })).toBeInTheDocument();
    expect(screen.queryByLabelText("Where to convert")).toBeNull();
    expect(screen.queryByLabelText("Quality away from home")).toBeNull();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  });
});

describe("where converted video is kept (engine 0.35+)", () => {
  const newer = (mapped: boolean, settings: object = {}) => ({
    ...state(kabyLake, { storage: "memory-disk", memoryMb: 1024, memoryPerViewerMb: 341, ...settings }),
    disk: { mapped, folder: "/transcode", freeBytes: mapped ? 400 * 1024 ** 3 : null, totalBytes: mapped ? 500 * 1024 ** 3 : null },
    storage: mapped ? "memory-disk" : "memory"
  });

  it("offers the disk once one is mapped, and saves in the new words alone", async () => {
    const puts: string[] = [];
    mockApi.mockImplementation((async (_path: string, options?: RequestInit) => {
      if (options?.method === "PUT") puts.push(options.body as string);
      return newer(true);
    }) as never);
    render(<VideoSettings prefix="/video" page="conversion" go={() => undefined} />);
    expect(await screen.findByText("Fast disk")).toBeInTheDocument();
    expect(screen.getByText("/transcode")).toBeInTheDocument();
    const mode = screen.getByLabelText("Keep converted video");
    expect(mode).toHaveValue("memory-disk");
    expect(screen.getByRole("option", { name: "On the disk only" })).not.toBeDisabled();
    // One pool, not memory per viewer.
    expect(screen.getByLabelText("Memory for conversion (MB)")).toHaveValue(1024);
    expect(screen.queryByLabelText("Memory per viewer (MB)")).toBeNull();

    await userEvent.selectOptions(mode, "memory");
    await waitFor(() => expect(puts).toHaveLength(1));
    const body = JSON.parse(puts[0]!);
    expect(body).toMatchObject({ storage: "memory", memoryMb: 1024 });
    expect(body).not.toHaveProperty("memoryPerViewerMb");
    expect(body).not.toHaveProperty("whenFull");
  });

  it("says there is no disk, and keeps to memory only", async () => {
    mockApi.mockResolvedValue(newer(false) as never);
    render(<VideoSettings prefix="/video" page="conversion" go={() => undefined} />);
    expect(await screen.findByText("No disk for video")).toBeInTheDocument();
    const mode = screen.getByLabelText("Keep converted video");
    expect(mode).toHaveValue("memory");
    expect(mode).toBeDisabled();
    expect(screen.getByRole("option", { name: "In memory, then on the disk" })).toBeDisabled();
  });
});
