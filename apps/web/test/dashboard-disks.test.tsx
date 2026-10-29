import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Overview } from "../src/features/control/sections/dashboard/Overview";
import type { DashboardOverview, OwnedDisk } from "../src/features/control/sections/dashboard/useDashboardOverview";
import type { SystemStatus } from "../src/features/control/types";

// The Dashboard's disks on an Unraid box (docs/dashboard-and-backups-plan.md →
// Disks): home's /config and /media both mapped from /mnt/user are one
// user-share filesystem, and the video engine's /media is that same filesystem
// too. Each folder gets its own bar, named with who measured it; the bars say
// they share one filesystem; a low one is reported once, not once per bar.

const status = {
  version: "4.45.1", runtime: "v26.0.0", uptimeSeconds: 3600, users: 5, activeSessions: 3, activeInvites: 0, logEntries: 10,
  databaseBytes: 1_000_000, memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1 }
} as unknown as SystemStatus;

const TB = 1_000_000_000_000;
const userShare = { filesystem: "51", freeBytes: 0.5 * TB, totalBytes: 24 * TB };

const overview: DashboardOverview = {
  home: { addresses: ["192.168.1.40"], port: 4000, publicUrl: "https://home.example" },
  failedSignIns24h: 0,
  failedTasks24h: 0,
  disks: [
    { mount: "/config", ...userShare, holds: [{ kind: "database", path: "/config/db" }], sharesWith: ["/media"] },
    { mount: "/media", ...userShare, holds: [{ kind: "library", name: "Audio English", path: "/media/media/audiobooks/Audible" }], sharesWith: ["/config"] }
  ]
};

const videoDisks: OwnedDisk[] = [
  { owner: "video", mount: "/media", ...userShare, holds: [{ kind: "library", name: "TV Shows", path: "/media/tvshows/TV Shows" }], sharesWith: [] }
];

describe("the Dashboard's disks", () => {
  it("draws a bar per mapped folder, says who measured it and which share one filesystem", () => {
    render(<Overview status={status} overview={overview} apps={[]} lastBackup={null} appErrors={{}} appDisks={videoDisks} />);
    expect(screen.getByText("/config")).toBeInTheDocument();
    expect(screen.getAllByText("/media")).toHaveLength(2);
    expect(screen.getByText("Libraries: Audio English")).toBeInTheDocument();
    expect(screen.getByText("Libraries: TV Shows")).toBeInTheDocument();
    expect(screen.getAllByText("Video")).not.toHaveLength(0);
    expect(screen.getByText("Same filesystem as /media, Video /media: the numbers are for all of them together.")).toBeInTheDocument();
  });

  it("reports a filesystem running low once, however many folders are mapped from it", () => {
    render(<Overview status={status} overview={overview} apps={[]} lastBackup={null} appErrors={{}} appDisks={videoDisks} />);
    expect(screen.getAllByText(/has 2% free/)).toHaveLength(1);
  });

  it("never calls two hosts' disks one because their device numbers happen to match", () => {
    const elsewhere: OwnedDisk[] = [{ ...videoDisks[0], totalBytes: 8 * TB, freeBytes: 4 * TB }];
    render(<Overview status={status} overview={overview} apps={[]} lastBackup={null} appErrors={{}} appDisks={elsewhere} />);
    expect(screen.queryByText(/Video \/media/)).not.toBeInTheDocument();
  });
});
