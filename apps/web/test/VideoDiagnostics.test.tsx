import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsPartPage } from "../src/features/control/diagnostics/PartPage";
import { gpuMaker } from "../src/features/control/diagnostics/VideoPage";

vi.mock("../src/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/api")>()), api: vi.fn() }));
const { api } = await import("../src/api");
const mockApi = vi.mocked(api);

// Diagnostics › Video (VideoPage.tsx): its tabs, and on Overview the GPU, what it
// decodes and encodes, the machine right now, and who is watching.
const hardware = {
  mode: "auto", device: "/dev/dri/renderD128", driver: "Intel iHD driver for Intel(R) Gen Graphics - 24.1.0 ()",
  encode: true, decode: ["h264", "hevc", "hevc10", "vp9"], encodeFormats: ["h264", "hevc"], tonemap: true, overlay: false,
  error: null, checking: false, setAside: false
};

beforeEach(() => {
  mockApi.mockReset();
  mockApi.mockImplementation(async (url: string) => {
    if (url.endsWith("/diagnostics/overview")) {
      return { parts: [{ id: "video", state: "ok", version: "0.41.0", roundTripMs: 3, problems: [], calls: { day: "2026-11-17", count: 40, failed: 0, since: "2026-11-17T06:00:00.000Z", lastAt: null, lastFailedAt: null, lastFailedStatus: null } }] };
    }
    if (url === "/api/apps/admin/status") return { apps: [{ id: "video", prefix: "/video", configured: true, server: { ok: true }, secretAccepted: true }] };
    if (url === "/video/api/admin/watching") {
      return { plays: [
        { kind: "converted", user: "Anna", itemId: "m1", title: "Dune", heading: "Dune (2021)", network: "home", device: "TV", since: "2026-11-17T10:00:00.000Z", mode: "convert", converter: "gpu", rung: 1080, converting: true, speed: 0.8, positionSeconds: 600, durationSeconds: 9000 },
        { kind: "direct", user: "Max", itemId: "e1", title: "The Expanse", network: "internet", device: "Phone", since: "2026-11-17T10:05:00.000Z", mbps: 12.5 }
      ] };
    }
    if (url === "/api/admin/diagnostics/now") return { at: "2026-11-17T10:10:00.000Z", cpu: { percent: 23, cores: 4, load: [1.1, 0.9, 0.8] }, memory: { totalBytes: 16e9, availableBytes: 9e9, homeBytes: 3e8 } };
    if (url === "/video/api/admin/conversion") return { available: true, settings: { maxViewers: 4, hardware: "auto" }, usage: { viewers: [], memoryBytes: 1.2e9, diskBytes: 0 }, hardware };
    if (url === "/video/api/admin/hardware/test") return { running: null, last: null, available: true };
    if (url === "/video/api/admin/libraries") return { libraries: [] };
    if (url.startsWith("/api/admin/diagnostics/saved")) return { reports: [], kept: 10 };
    if (url.endsWith("/logging")) return { level: "normal", until: null, minutes: [15, 60, 240] };
    return {};
  });
});

describe("Diagnostics › Video", () => {
  it("has tabs, and on Overview the GPU, its capabilities and the machine right now", async () => {
    render(<DiagnosticsPartPage part="video" tab="overview" />);
    const tabs = await screen.findByRole("tablist", { name: "Video diagnostics" });
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent?.replace(/\d+$/, ""))).toEqual(["Overview", "GPU tests", "Live sessions", "Logs", "Reports"]);
    // How many are watching, on its tab.
    expect(await within(tabs).findByRole("tab", { name: "Live sessions2" })).toBeTruthy();
    expect(within(tabs).getByRole("tab", { name: /Overview/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/Answers in 3 ms · 40 requests today, 0 failed/)).toBeTruthy();

    const gpu = (await screen.findByRole("heading", { name: "Intel graphics" })).closest("section") as HTMLElement;
    expect(within(gpu).getByText("In use")).toBeTruthy();
    expect(within(gpu).getByText("Ready to convert")).toBeTruthy();

    // HEVC encodes (vainfo said so), AV1 doesn't decode; subtitles are drawn on the CPU.
    const caps = screen.getByRole("heading", { name: "Capabilities" }).closest("section") as HTMLElement;
    const hevc = within(caps).getByRole("rowheader", { name: "HEVC" }).closest("tr") as HTMLElement;
    expect(within(hevc).getAllByLabelText("Yes")).toHaveLength(2);
    const av1 = within(caps).getByRole("rowheader", { name: "AV1" }).closest("tr") as HTMLElement;
    expect(within(av1).getAllByLabelText("No")).toHaveLength(2);
    expect(within(within(caps).getByRole("rowheader", { name: "Subtitles" }).closest("tr") as HTMLElement).getByText("on the CPU")).toBeTruthy();

    // Right now: a conversion falling behind, the CPU and memory, what is being sent.
    const now = screen.getByRole("heading", { name: "Right now" }).closest("section") as HTMLElement;
    expect(await within(now).findByText("Dune (2021): 0.8× real time")).toBeTruthy();
    expect(within(now).getByText("Falling behind")).toBeTruthy();
    expect(await within(now).findByText("CPU 23%")).toBeTruthy();
    expect(within(now).getByText(/conversions hold/)).toBeTruthy();
    expect(within(now).getByText("12.5 Mbit/s to 2 viewers")).toBeTruthy();

    expect(screen.getByRole("heading", { name: "Live sessions · 2" })).toBeTruthy();
    expect(screen.getByText(/Not run yet/)).toBeTruthy();
  });

  it("tells the GPU's maker from its driver", () => {
    expect(gpuMaker({ driver: "Intel iHD driver for Intel(R) Gen Graphics - 24.1.0 ()" })).toBe("intel");
    expect(gpuMaker({ driver: "Mesa Gallium driver 24.0.5 for AMD Radeon RX 6600" })).toBe("amd");
    expect(gpuMaker({ driver: "NVIDIA VDPAU backend" })).toBe("nvidia");
    expect(gpuMaker({ driver: null })).toBe("other");
  });
});
