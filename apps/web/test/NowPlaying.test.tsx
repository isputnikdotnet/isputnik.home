import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clockOf, NowPlayingSection } from "../src/features/control/sections/NowPlayingSection";

vi.mock("../src/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/api")>()), api: vi.fn() }));
const { api } = await import("../src/api");
const mockApi = vi.mocked(api);

// Infrastructure › Now playing: a card a stream, the way Plex's dashboard shows
// them — the poster, what it is and how far through, Direct Play or Transcode,
// quality and bandwidth, who, on what and from where.
const video = { id: "video", prefix: "/video", configured: true, secretAccepted: true, server: { ok: true, version: "0.40.0", error: null, roundTripMs: 4 } };
const now = new Date().toISOString();

beforeEach(() => {
  mockApi.mockReset();
});

const answer = (plays: object[]) => mockApi.mockImplementation((async (url: string) => {
  if (url === "/api/apps/admin/status") return { apps: [video] };
  if (url === "/video/api/admin/watching") return { plays };
  throw new Error(`unexpected ${url}`);
}) as never);

describe("Now playing", () => {
  it("shows each stream as a card: poster, how far through, how it plays, who and where", async () => {
    answer([
      { kind: "direct", user: "Mum", itemId: "e2", title: "Радар S01E02", type: "episode", heading: "Радар", subheading: "S1 · E2 · Pilot", poster: "/video/api/art/s1/poster?v=1", backdrop: null, network: "internet", device: "Phone", since: now, mbps: 8.4, positionSeconds: 1330, durationSeconds: 2700 },
      { kind: "converted", user: "Dad", itemId: "m1", title: "Dune", type: "movie", heading: "Dune", subheading: "2021", poster: null, backdrop: null, network: "home", device: "TV", since: now, mode: "transcode", converter: "gpu", rung: 1080, hdr: true, converting: true, positionSeconds: 3725, durationSeconds: 9300 }
    ]);
    render(<NowPlayingSection />);
    const mum = await screen.findByRole("article", { name: "Mum · Радар" });
    expect(within(mum).getByText("S1 · E2 · Pilot")).toBeTruthy();
    expect(within(mum).getByText("Direct Play")).toBeTruthy();
    expect(within(mum).getByText("8.4 Mbit/s")).toBeTruthy();
    expect(within(mum).getByText("22:10 / 45:00")).toBeTruthy();
    expect(within(mum).getByText("Away from home")).toBeTruthy();
    const dad = screen.getByRole("article", { name: "Dad · Dune" });
    expect(within(dad).getByText("Transcode · GPU")).toBeTruthy();
    expect(within(dad).getByText("Up to 1080p · HDR")).toBeTruthy();
    expect(within(dad).getByText("1:02:05 / 2:35:00")).toBeTruthy();
    expect(screen.getByText("2 streams")).toBeTruthy();
    expect(screen.getByText("1 being converted")).toBeTruthy();
  });

  it("says what the file is, what is sent of it, and why it is converted", async () => {
    const source = {
      container: "mkv",
      video: { codec: "hevc", profile: "Main 10", width: 3840, height: 1600, bitDepth: 10, hdr: "pq" },
      audio: { codec: "truehd", channels: 8, language: "eng" },
      bitRate: 61_400_000
    };
    const direct = { container: "mp4", video: { codec: "h264", profile: "High", width: 1920, height: 1080, bitDepth: 8, hdr: null }, audio: { codec: "aac", channels: 2, language: null }, bitRate: 8_000_000 };
    answer([
      {
        kind: "converted", user: "Dad", itemId: "m1", title: "Inception", heading: "Inception", network: "home", device: "Browser", since: now, mode: "transcode", converter: "gpu", rung: null, converting: true,
        media: {
          source,
          sent: { container: "hls", video: { codec: "h264", profile: "High", width: 2592, height: 1080, bitDepth: 8, hdr: null }, audio: { codec: "aac", channels: 2, language: "eng" }, bitRate: null },
          reasons: ["container", "audio", "video", "subtitles"], videoCopied: false, audioCopied: false, subtitlesBurned: true,
          subtitle: { codec: "hdmv_pgs_subtitle", language: "eng", title: null, forced: false }
        },
        pipeline: { decode: "gpu", tonemap: "cpu", scale: "gpu", overlay: "gpu", encode: "gpu" }
      },
      { kind: "direct", user: "Mum", itemId: "m2", title: "Up", heading: "Up", network: "home", device: "TV", since: now, mbps: 6, media: { source: direct, sent: direct, reasons: [], videoCopied: true, audioCopied: true, subtitlesBurned: false } }
    ]);
    render(<NowPlayingSection />);
    const dad = await screen.findByRole("article", { name: "Dad · Inception" });
    // Video: the file, what the player gets, and each step lit where the GPU does it.
    expect(within(dad).getByText("4K (HEVC Main 10) · 10-bit · HDR10 · 3840×1600")).toBeTruthy();
    expect(within(dad).getByText("1080p (H.264)")).toBeTruthy();
    expect(within(dad).getByRole("listitem", { name: "Decode: On the GPU" }).className).toBe("is-lit");
    expect(within(dad).getByRole("listitem", { name: "HDR → SDR: On the CPU" }).className).toBe("is-cpu");
    expect(within(dad).getByRole("listitem", { name: "Encode: On the GPU" }).className).toBe("is-lit");
    // Audio, the burned-in subtitle, and the container with why it is converted.
    expect(within(dad).getByText("English · TrueHD 7.1")).toBeTruthy();
    expect(within(dad).getByText("AAC Stereo")).toBeTruthy();
    expect(within(dad).getByText("English · PGS")).toBeTruthy();
    expect(within(dad).getByText("Burned into the picture")).toBeTruthy();
    expect(within(dad).getByRole("listitem", { name: "Burn in: On the GPU" })).toBeTruthy();
    expect(within(dad).getByText("MKV · 61.4 Mbit/s")).toBeTruthy();
    expect(within(dad).getByText(/Converted for the container, the sound, the picture, subtitles drawn on/)).toBeTruthy();
    const mum = screen.getByRole("article", { name: "Mum · Up" });
    expect(within(mum).getByText("1080p (H.264 High) · 1920×1080")).toBeTruthy();
    expect(within(mum).getAllByText("As it is")).toHaveLength(3);
    expect(within(mum).getAllByRole("listitem", { name: /Copied/ })).toHaveLength(2);
  });

  it("says when nobody is watching", async () => {
    answer([]);
    render(<NowPlayingSection />);
    expect(await screen.findByText("Nobody is watching right now.")).toBeTruthy();
  });
});

describe("the clock", () => {
  it("reads like a player's", () => {
    expect(clockOf(65)).toBe("1:05");
    expect(clockOf(3725)).toBe("1:02:05");
  });
});
