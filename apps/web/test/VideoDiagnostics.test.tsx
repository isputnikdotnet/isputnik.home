import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsPartPage } from "../src/features/control/diagnostics/PartPage";
import { cpuPicture, gpuMaker, gpuPicture } from "../src/features/control/diagnostics/VideoPage";

vi.mock("../src/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/api")>()), api: vi.fn() }));
const { api } = await import("../src/api");
const mockApi = vi.mocked(api);

// Diagnostics › Video (VideoPage.tsx): its tabs, and on Overview the GPU, what it
// decodes and encodes, the machine right now, and who is watching.
const hardware = {
  mode: "auto", device: "/dev/dri/renderD128", driver: "Intel iHD driver for Intel(R) Gen Graphics - 24.1.0 ()",
  pci: { vendor: "0x8086", device: "0x5912" }, cpu: "Intel(R) Core(TM) i5-7500 CPU @ 3.40GHz",
  encode: true, decode: ["h264", "hevc", "hevc10", "vp9"], encodeFormats: ["h264", "hevc"], cpuDecoders: ["mpeg4", "h264", "vvc"], maxDecode: { width: 8192, height: 8192 }, tonemap: true, overlay: false,
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
    if (url === "/video/api/admin/conversion") return { available: true, settings: { maxViewers: 4, hardware: "auto", memoryMb: 2048, memoryPerViewerMb: 512 }, usage: { viewers: [], memoryBytes: 1.2e9, diskBytes: 0, kept: { count: 3, bytes: 12e9 } }, disk: { mapped: false, folder: "/cache", freeBytes: null, totalBytes: null }, hardware };
    if (url === "/video/api/admin/hardware/test") return { running: null, last: null, available: true };
    if (url === "/video/api/admin/libraries") return { libraries: [] };
    if (url.startsWith("/api/admin/diagnostics/saved")) return { reports: [], kept: 10 };
    if (url.endsWith("/logging")) return { level: "normal", until: null, minutes: [15, 60, 240] };
    return {};
  });
});

describe("Diagnostics › Video", () => {
  it("has tabs, and on Overview cards of how things stand, the hardware and the formats it plays", async () => {
    render(<DiagnosticsPartPage part="video" tab="overview" />);
    const tabs = await screen.findByRole("tablist", { name: "Video diagnostics" });
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent?.replace(/\d+$/, ""))).toEqual(["Overview", "GPU tests", "Live sessions", "Server log", "Reports"]);
    // How many are watching, on its tab.
    expect(await within(tabs).findByRole("tab", { name: "Live sessions2" })).toBeTruthy();
    expect(within(tabs).getByRole("tab", { name: /Overview/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/Answers in 3 ms · 40 requests today, 0 failed/)).toBeTruthy();

    // Hardware: the CPU, the memory and the GPU (passed to the container), with pictures.
    const hw = (await screen.findByRole("heading", { name: "Hardware" })).closest("section") as HTMLElement;
    expect(within(hw).getByText("In use")).toBeTruthy();
    expect(await within(hw).findByText("Intel(R) Core(TM) i5-7500 CPU @ 3.40GHz")).toBeTruthy();
    expect(within(hw).getByText("Intel graphics")).toBeTruthy();
    expect(within(hw).getByText("Passed to the video container · /dev/dri/renderD128")).toBeTruthy();
    // The HD 630 in an i5-7500: the older Quick Sync's picture, for the CPU and the GPU alike.
    expect([...hw.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual(["/Assets/gpu/intel-quicksync-legacy.webp", "/Assets/gpu/intel-quicksync-legacy.webp"]);

    // The formats: lit where the GPU does it; HEVC it encodes too (vainfo said so), AV1 it doesn't decode.
    const formats = within(hw).getByRole("list", { name: "Hardware decoding" });
    const encoding = within(hw).getByRole("list", { name: "Hardware encoding" });
    const extras = within(hw).getByRole("list", { name: "Additional capabilities" });
    expect(within(formats).getByLabelText("HEVC: On the GPU")).toHaveClass("is-lit");
    expect(within(encoding).getByLabelText("HEVC: On the GPU")).toHaveClass("is-lit");
    expect(within(encoding).getByLabelText("AV1: Doesn't encode it on the GPU")).not.toHaveClass("is-lit");
    expect(within(formats).getByLabelText("VP9: On the GPU")).toHaveClass("is-lit");
    expect(within(formats).getByLabelText("HEVC 12-bit: On the CPU")).not.toHaveClass("is-lit");
    expect(within(formats).getByLabelText("AV1: On the CPU")).not.toHaveClass("is-lit");
    expect(within(extras).getByLabelText("HDR → SDR: On the GPU")).toHaveClass("is-lit");
    expect(within(extras).getByLabelText("Hardware scaling: On the GPU")).toHaveClass("is-lit");
    // The CPU's own decoders, by what the engine's ffmpeg has.
    expect(within(within(hw).getByRole("list", { name: "Software fallback" })).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["DivX / Xvid", "H.264 10-bit", "VVC"]);
    expect(within(extras).getByLabelText("Subtitles: On the CPU")).not.toHaveClass("is-lit");
    expect(within(extras).getByLabelText(/^4K: Decodes pictures up to 8192×8192/)).toHaveClass("is-lit");
    expect(screen.queryByRole("heading", { name: "Capabilities" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "GPU test results" })).toBeNull();

    // At a glance: cards of how things stand, no graphs (they're on Live sessions).
    const tiles = screen.getByRole("heading", { name: "At a glance" }).closest("section") as HTMLElement;
    const card = (label: string) => within(tiles).getByText(label).closest(".stat-tile") as HTMLElement;
    expect(await within(card("CPU")).findByText("23%")).toBeTruthy();
    expect(within(card("Live sessions")).getByText("2")).toBeTruthy();
    expect(within(card("Live sessions")).getByText("1 converting")).toBeTruthy();
    expect(within(card("Sending now")).getByText("12.5 Mbit/s")).toBeTruthy();
    expect(within(card("Conversion")).getByText("Automatic — GPU first")).toBeTruthy();
    expect(within(card("Memory for conversions")).getByText("2.00 GB")).toBeTruthy();
    expect(within(card("Disk for conversions")).getByText("No disk mapped")).toBeTruthy();
    expect(within(card("Films kept ready")).getByText("3")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Right now" })).toBeNull();
  });

  it("puts the machine right now, as graphs, over the live sessions", async () => {
    render(<DiagnosticsPartPage part="video" tab="sessions" />);
    const now = (await screen.findByRole("heading", { name: "Right now" })).closest("section") as HTMLElement;
    expect(await within(now).findByText("Dune (2021): 0.8× real time")).toBeTruthy();
    expect(within(now).getByText("Falling behind")).toBeTruthy();
    expect(await within(now).findByText("CPU 23%")).toBeTruthy();
    expect(within(now).getByText(/conversions hold/)).toBeTruthy();
    expect(within(now).getByText("12.5 Mbit/s to 2 viewers")).toBeTruthy();
    // Then the cards of who is watching, under the graphs.
    const watching = await screen.findByRole("article", { name: /Anna/ });
    expect(now.compareDocumentPosition(watching) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // Beside Reports (and Overview, Server log): its events, activity and tasks, each
  // opened on Video only — not this server's.
  it("links to Video's own events, activity and tasks", async () => {
    render(<DiagnosticsPartPage part="video" tab="reports" />);
    expect(await screen.findByText("Each opens on Video only.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /^Events/ })).toHaveAttribute("href", "/control/infrastructure/logs?app=video");
    expect(screen.getByRole("link", { name: /^Activity/ })).toHaveAttribute("href", "/control/infrastructure/activity?application=videos");
    expect(screen.getByRole("link", { name: /^Tasks/ })).toHaveAttribute("href", "/control/infrastructure/tasks?application=videos");
  });

  it("picks the GPU's picture by its PCI ids, and the CPU's by its model", () => {
    const gpu = (vendor: string, device: string) => ({ driver: null, pci: { vendor, device } });
    expect(gpuPicture(gpu("0x8086", "0x56a5"))).toBe("intel-arc-a300"); // Arc A380
    expect(gpuPicture(gpu("0x8086", "0x56a0"))).toBe("intel-arc-a700"); // Arc A770
    expect(gpuPicture(gpu("0x8086", "0xe20b"))).toBe("intel-arc-a700"); // Arc B580
    expect(gpuPicture(gpu("0x8086", "0x5912"))).toBe("intel-quicksync-legacy"); // HD 630, Kaby Lake
    expect(gpuPicture(gpu("0x8086", "0x9bc8"))).toBe("intel-quicksync-legacy"); // Comet Lake
    expect(gpuPicture(gpu("0x8086", "0x4680"))).toBe("intel-quicksync-modern"); // Alder Lake
    expect(gpuPicture(gpu("0x8086", "0x46d0"))).toBe("intel-quicksync-modern"); // N100
    expect(gpuPicture(gpu("0x1002", "0x73ff"))).toBe("amd-radeon-gpu");
    expect(gpuPicture(gpu("0x10de", "0x2504"))).toBe("nvidia-gpu");
    // An engine before 0.41: the driver's name only.
    expect(gpuPicture({ driver: "Intel iHD driver 24.1" })).toBe("intel-quicksync-modern");
    expect(gpuPicture({ driver: null })).toBe("generic-gpu");

    expect(cpuPicture("AMD Ryzen 7 5700G with Radeon Graphics")).toBe("amd-cpu");
    expect(cpuPicture("Intel(R) Core(TM) i5-7500 CPU @ 3.40GHz")).toBe("intel-quicksync-legacy");
    expect(cpuPicture("Intel(R) Core(TM) i7-10700 CPU @ 2.90GHz")).toBe("intel-quicksync-modern");
    expect(cpuPicture("12th Gen Intel(R) Core(TM) i7-12700K")).toBe("intel-quicksync-modern");
    expect(cpuPicture("Intel(R) N100")).toBe("intel-quicksync-modern");
    expect(cpuPicture("ARM Cortex-A72")).toBeNull();
    expect(cpuPicture(null)).toBeNull();
  });

  it("tells the GPU's maker from its driver", () => {
    expect(gpuMaker({ driver: "Intel iHD driver for Intel(R) Gen Graphics - 24.1.0 ()" })).toBe("intel");
    expect(gpuMaker({ driver: "Mesa Gallium driver 24.0.5 for AMD Radeon RX 6600" })).toBe("amd");
    expect(gpuMaker({ driver: "NVIDIA VDPAU backend" })).toBe("nvidia");
    expect(gpuMaker({ driver: null })).toBe("other");
  });
});
