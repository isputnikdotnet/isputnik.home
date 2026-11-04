import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Settings → Video → Converting video: what the engine found the GPU does
// (isputnik.video 0.20+, hardware.ts), Check again, and where to convert.

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});

const { api } = await import("../src/api");
const { VideoConversion } = await import("../src/features/control/sections/AppsSection");
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
    render(<VideoConversion prefix="/video" />);
    expect(await screen.findByText("Converting on the GPU")).toBeInTheDocument();
    expect(screen.getByText(/HEVC 10-bit/)).toBeInTheDocument();
    expect(screen.getByText(/\/dev\/dri\/renderD128 · Intel iHD driver 24\.1/)).toBeInTheDocument();
    expect(screen.getByText(/· GPU/)).toBeInTheDocument();
  });

  it("checks again on asking, and saves where to convert", async () => {
    const calls: { path: string; method: string; body?: string }[] = [];
    mockApi.mockImplementation((async (path: string, options?: RequestInit) => {
      calls.push({ path, method: options?.method ?? "GET", body: options?.body as string | undefined });
      if (options?.method === "POST") return state({ ...kabyLake, encode: false, decode: [], error: "No GPU: /dev/dri is not passed to the container" });
      return state(kabyLake);
    }) as never);
    render(<VideoConversion prefix="/video" />);
    await userEvent.click(await screen.findByRole("button", { name: "Check again" }));
    expect(await screen.findByText("No GPU: /dev/dri is not passed to the container")).toBeInTheDocument();
    expect(calls.some((call) => call.method === "POST" && call.path === "/video/api/admin/conversion/check")).toBe(true);

    await userEvent.selectOptions(screen.getByLabelText("Where to convert"), "cpu");
    await userEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(calls.find((call) => call.method === "PUT")).toBeDefined());
    expect(JSON.parse(calls.find((call) => call.method === "PUT")!.body!)).toMatchObject({ hardware: "cpu" });
  });

  it("offers no GPU setting to an engine from before it had one", async () => {
    mockApi.mockResolvedValue(state(undefined) as never);
    render(<VideoConversion prefix="/video" />);
    expect(await screen.findByLabelText("People watching converted video at once", { exact: false })).toBeInTheDocument();
    expect(screen.queryByLabelText("Where to convert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  });
});
