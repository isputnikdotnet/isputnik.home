import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredVideoDownload } from "../src/offline/video-store";

// The Downloads page's film rows: a row that waits says how many are before it —
// on the server, where its copy is made, or on this device — and one that moves
// says roughly how long it still needs.

const { VideoDownloadsList } = await import("../src/features/video/VideoDownloadsList");

let turn = 0;
function record(over: Partial<StoredVideoDownload>): StoredVideoDownload {
  turn += 1;
  return {
    id: `v${turn}`, title: `Film ${turn}`, showTitle: null, season: null, episode: null,
    parent: { kind: "movie", id: `m${turn}` }, quality: 720, posterUrl: null, kind: null, info: null,
    prepare: null, mime: null, playlist: null, subtitles: [], totalParts: null, doneParts: 0,
    totalBytes: null, estimatedBytes: null, downloadedBytes: 0, state: "queued", problem: null,
    createdAt: "2026-11-22T10:00:00Z", queuedAt: turn, position: null,
    ...over
  } as StoredVideoDownload;
}
const prepare = (over: object) => ({ progress: 0, ahead: 0, paused: false, etaSeconds: null, waitingFor: null, ...over });

afterEach(() => vi.useRealTimers());

describe("a film's row on the Downloads page", () => {
  it("says how many copies the server makes first", () => {
    render(<VideoDownloadsList records={[
      record({ state: "preparing", prepare: prepare({ ahead: 2 }) }),
      record({ state: "preparing", prepare: prepare({ ahead: 1, waitingFor: "night" }) })
    ]} />);
    expect(screen.getByText("Waiting for the server to prepare it · 2 copies ahead of it on the server")).toBeInTheDocument();
    expect(screen.getByText("Waiting for the night to be prepared · 1 copy ahead of it on the server")).toBeInTheDocument();
  });

  it("says how long a copy being made still needs, and nothing while it stands still", () => {
    render(<VideoDownloadsList records={[
      record({ state: "preparing", prepare: prepare({ progress: 0.4, etaSeconds: 380 }) }),
      record({ state: "preparing", prepare: prepare({ progress: 0.2, paused: true, etaSeconds: null }) }),
      record({ state: "preparing", prepare: prepare({ progress: 0.9, etaSeconds: 20 }) })
    ]} />);
    expect(screen.getByText("Preparing on the server: 40% · about 6 min left")).toBeInTheDocument();
    expect(screen.getByText("Preparing paused while someone is watching")).toBeInTheDocument();
    expect(screen.getByText("Preparing on the server: 90% · less than a minute left")).toBeInTheDocument();
  });

  it("says how many of this device's downloads take their turn first", () => {
    render(<VideoDownloadsList records={[
      record({ state: "downloading", kind: "file", totalBytes: 1000, downloadedBytes: 100 }),
      record({ state: "complete" }),
      record({ state: "queued" }),
      record({ state: "queued" })
    ]} />);
    expect(screen.getByText("Waiting to download · 1 download ahead of it on this device")).toBeInTheDocument();
    expect(screen.getByText("Waiting to download · 2 downloads ahead of it on this device")).toBeInTheDocument();
  });

  it("works out the time left from how fast it comes down, and says a failure plainly", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-22T10:00:00Z"));
    const film = record({ state: "downloading", kind: "file", totalBytes: 1000, downloadedBytes: 100 });
    const { rerender } = render(<VideoDownloadsList records={[film]} />);
    // Nothing to go on yet.
    expect(screen.getByText("Downloading 10%")).toBeInTheDocument();
    // A tenth more in ten seconds: eight tenths to go, eighty seconds.
    vi.setSystemTime(new Date("2026-11-22T10:00:10Z"));
    rerender(<VideoDownloadsList records={[{ ...film, downloadedBytes: 200 }]} />);
    expect(screen.getByText("Downloading 20% · about 1 min left")).toBeInTheDocument();

    rerender(<VideoDownloadsList records={[{ ...film, state: "failed", problem: "connection" }]} />);
    expect(screen.queryByText(/left$/)).toBeNull();
    expect(screen.queryByText(/ahead of it/)).toBeNull();
  });
});
