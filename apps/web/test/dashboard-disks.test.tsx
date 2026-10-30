import { cleanup, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Overview } from "../src/features/control/sections/dashboard/Overview";
import type { AppBackupSummary, DashboardOverview, OwnedDisk } from "../src/features/control/sections/dashboard/useDashboardOverview";
import type { SystemStatus } from "../src/features/control/types";

// The Dashboard's disks on an Unraid box (docs/dashboard-and-backups-plan.md →
// Disks): home's /config and /media both mapped from /mnt/user are one
// user-share filesystem, and the video engine's /media is that same filesystem
// too. They are one bar, listing each folder with who measured it and what it
// holds, and a low one is reported once. Each container's last backup has a row.

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

const bars = () => screen.getAllByRole("meter");

describe("the Dashboard's disks", () => {
  it("draws one bar for a filesystem, however many containers map folders from it", () => {
    render(<Overview status={status} overview={overview} apps={[]} lastBackup={null} appErrors={{}} appDisks={videoDisks} />);
    expect(bars()).toHaveLength(1);
    expect(screen.getByText("3 folders on this drive")).toBeInTheDocument();
    expect(screen.getByText("/config")).toBeInTheDocument();
    expect(screen.getAllByText("/media")).toHaveLength(2);
    expect(screen.getByText("Libraries: Audio English")).toBeInTheDocument();
    expect(screen.getByText("Libraries: TV Shows")).toBeInTheDocument();
    expect(screen.getAllByText("Video")).not.toHaveLength(0);
  });

  it("reports a filesystem running low once, naming each folder once", () => {
    render(<Overview status={status} overview={overview} apps={[]} lastBackup={null} appErrors={{}} appDisks={videoDisks} />);
    expect(screen.getAllByText(/has 2% free/)).toHaveLength(1);
    expect(screen.getByText(/\/config, \/media has 2% free/)).toBeInTheDocument();
  });

  it("never calls two hosts' disks one because their device numbers happen to match", () => {
    const elsewhere: OwnedDisk[] = [{ ...videoDisks[0], totalBytes: 8 * TB, freeBytes: 4 * TB }];
    render(<Overview status={status} overview={overview} apps={[]} lastBackup={null} appErrors={{}} appDisks={elsewhere} />);
    expect(bars()).toHaveLength(2);
  });

  it("keeps a drive with one folder as it was", () => {
    const one: OwnedDisk[] = [{ ...videoDisks[0], filesystem: "99" }];
    render(<Overview status={status} overview={{ ...overview, disks: [] }} apps={[]} lastBackup={null} appErrors={{}} appDisks={one} />);
    expect(bars()).toHaveLength(1);
    expect(screen.queryByText(/folders? on this drive/)).not.toBeInTheDocument();
    expect(screen.getByText("/media")).toBeInTheDocument();
  });
});

describe("each container's last backup", () => {
  const now = new Date().toISOString();
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const base: AppBackupSummary = { id: "games", configured: true, include: true, files: [], undo: null };
  const draw = (appBackups?: AppBackupSummary[]) =>
    render(<Overview status={status} overview={{ ...overview, disks: [] }} apps={[]} lastBackup={undefined} appErrors={{}} appDisks={[]} appBackups={appBackups} />);

  it("gives a row to each container, linked to its card", () => {
    draw([{ ...base, files: [{ createdAt: now, source: "own" }] }, { ...base, id: "video", files: [{ createdAt: now, source: "minimal" }] }]);
    expect(screen.getByRole("link", { name: /^Games/ })).toHaveAttribute("href", expect.stringMatching(/#container-backup-games$/));
    expect(screen.getByText(/Its own backup/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Video/ })).toHaveAttribute("href", expect.stringMatching(/#container-backup-video$/));
    expect(screen.queryByText(/has no backup/)).not.toBeInTheDocument();
  });

  it("flags a container with no backup, or an old one", () => {
    draw([base, { ...base, id: "video", files: [{ createdAt: longAgo, source: "own" }] }]);
    expect(screen.getByText("Games has no backup yet.")).toBeInTheDocument();
    expect(screen.getByText(/The last backup of Video was/)).toBeInTheDocument();
  });

  it("does not flag a container left out on purpose, and says so", () => {
    draw([{ ...base, include: false }]);
    expect(screen.queryByText(/has no backup/)).not.toBeInTheDocument();
    expect(screen.getByText("Left out of Full and Minimal backups.")).toBeInTheDocument();
  });

  it("says a restore can be undone", () => {
    draw([{ ...base, files: [{ createdAt: now, source: "own" }], undo: { takenAt: now } }]);
    expect(screen.getByText(/can be undone/)).toBeInTheDocument();
  });

  it("skips a container that is not set up and has no backups, and shows nothing when unreadable", () => {
    draw([{ ...base, configured: false }]);
    expect(screen.queryByRole("link", { name: /^Games/ })).not.toBeInTheDocument();
    cleanup();
    draw(undefined);
    expect(screen.queryByRole("link", { name: /^Games/ })).not.toBeInTheDocument();
  });
});
