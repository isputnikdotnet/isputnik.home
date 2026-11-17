import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsPartPage } from "../src/features/control/diagnostics/PartPage";

vi.mock("../src/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/api")>()), api: vi.fn() }));
const { api } = await import("../src/api");
const mockApi = vi.mocked(api);

// One part's page under Diagnostics (docs/diagnostics-pages-plan.md): this
// server's libraries and backups, how the other containers answer, where to
// look next, and the report dialog opened with that part only.
const calls = (count: number, failed: number) => ({ day: "2026-11-14", count, failed, since: "2026-11-14T06:00:00.000Z", lastAt: null, lastFailedAt: null, lastFailedStatus: null });
const parts = [
  {
    id: "home", state: "attention", version: "4.90.0", roundTripMs: null, uptimeSeconds: 7200,
    problems: [{ kind: "folderMissing", library: "Kids", libraryId: "lib-kids" }],
    libraryChecks: [
      { id: "lib-kids", name: "Kids", type: "gallery", state: "missing", ms: null },
      { id: "lib-books", name: "Books", type: "ebook", state: "ok", ms: 12 },
      { id: "lib-films", name: "Films", type: "video", state: "container", ms: null }
    ],
    lastBackup: { at: "2026-11-13T02:00:00.000Z", kind: "full", sizeBytes: 2_000_000_000 },
    backupError: null,
    machine: { node: "v24.16.0", os: "linux 6.1 x64", cpus: 4, memoryBytes: 16e9, rssBytes: 2e8 }
  },
  { id: "video", state: "ok", version: "0.39.0", roundTripMs: 6, problems: [], calls: calls(1204, 3) },
  { id: "faces", state: "off", version: null, roundTripMs: null, problems: [], calls: calls(0, 0) }
];

const testsState = {
  running: null,
  folders: { at: "2026-11-14T09:00:00.000Z", ms: 900, libraries: [
    { libraryId: "lib-books", name: "Books", type: "ebook", firstMs: 7800, secondMs: 12, asleep: true, read: { bytes: 64e6, seconds: 0.8, mbitPerSecond: 610.2 }, verdict: "ok", error: null }
  ] },
  backup: { name: "isputnik-20261113-020000.zip", createdAt: "2026-11-13T02:00:00.000Z", sizeBytes: 2e9, ok: true, files: 4812, bytes: 2.1e9, manifest: { kind: "full", version: "4.90.0" }, database: { found: true, integrity: "ok", tables: 120 }, error: null, ms: 60000 },
  speed: null,
  runs: [{ kind: "backup", at: "2026-11-14T09:30:00.000Z", ok: true, facts: { createdAt: "2026-11-13T02:00:00.000Z", files: 4812 } }]
};

beforeEach(() => {
  mockApi.mockReset();
  mockApi.mockImplementation(async (url: string) => {
    if (url.endsWith("/overview")) return { parts };
    if (url.endsWith("/diagnostics/tests/folders")) return { ...testsState, running: { kind: "folders", startedAt: "2026-11-14T10:00:00.000Z", step: "Kids" } };
    if (url.endsWith("/diagnostics/tests")) return testsState;
    if (url.endsWith("/logging")) return { level: "normal", until: null, minutes: [15, 60, 240] };
    if (url.includes("/api/admin/apps")) return { apps: [] };
    if (url.startsWith("/api/admin/diagnostics/saved")) return { reports: [], kept: 10 };
    return { report: { generatedAt: "2026-11-14T10:00:00.000Z", includesPrivate: false, hidden: ["people", "paths", "names", "net"], sections: [
      { key: "system", title: "isputnik.home", lines: ["version: 4.90.0"] },
      { key: "container:video", title: "video container", lines: ["gpu: vaapi"] }
    ] } };
  });
});

describe("this server's page", () => {
  it("lists each library's folder, the backup, the other containers and where to look next", async () => {
    render(<DiagnosticsPartPage part="home" />);
    expect(await screen.findByText("iSputnik needs a look")).toBeTruthy();
    const libraries = screen.getByText("Libraries").closest("section") ?? document.body;
    expect(within(libraries as HTMLElement).getByText(/gallery · folder isn't reachable/)).toBeTruthy();
    expect(within(libraries as HTMLElement).getByText(/video · checked by the video container/)).toBeTruthy();
    expect(screen.getByText(/full · 1\.9 GB|full · 2 GB|full · 1\.86 GB/)).toBeTruthy();
    expect(screen.getByText(/Answers in 6 ms · 1204 requests today, 3 failed/)).toBeTruthy();
    expect(screen.getByText("Logs and events")).toBeTruthy();
  });

  it("opens the report with this server's parts only, and no private details", async () => {
    const user = userEvent.setup();
    render(<DiagnosticsPartPage part="home" />);
    await user.click(await screen.findByRole("button", { name: /Download report/ }));
    const dialog = await screen.findByRole("dialog");
    // Private details are switched off on the Privacy tab; the text is on Report.
    await user.click(await within(dialog).findByRole("tab", { name: "Privacy" }));
    for (const name of [/Include names of people/, /Include folders and file paths/, /Include names of libraries/, /Include addresses/]) {
      expect((await within(dialog).findByRole("switch", { name })).getAttribute("aria-checked")).toBe("false");
    }
    await user.click(within(dialog).getByRole("tab", { name: "Report" }));
    expect(await within(dialog).findByText(/version: 4\.90\.0/)).toBeTruthy();
    expect(within(dialog).queryByText(/gpu: vaapi/)).toBeNull();
    expect(mockApi).toHaveBeenCalledWith("/api/admin/diagnostics?hide=people,paths,names,net&since=day");
  });
});

describe("this server's tests", () => {
  it("shows what the last runs found, and starts a test when asked", async () => {
    const user = userEvent.setup();
    render(<DiagnosticsPartPage part="home" />);
    expect(await screen.findByText(/first answer 7800 ms, then 12 ms \(a disk was asleep\) · reads 610 Mbit\/s/)).toBeTruthy();
    expect(screen.getByText("The last backup is intact")).toBeTruthy();
    expect(screen.getByText("Recent runs")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Check folders" }));
    expect(mockApi).toHaveBeenCalledWith("/api/admin/diagnostics/tests/folders", { method: "POST" });
    expect(await screen.findAllByRole("button", { name: "Running…" })).toHaveLength(1);
    // The other server test waits while this one runs.
    expect(screen.getByRole("button", { name: "Waits for the other test" })).toBeTruthy();
  });
});

describe("a container's page", () => {
  it("shows its connection and the requests through this server, over its tabs", async () => {
    render(<DiagnosticsPartPage part="video" />);
    // Healthy: no banner, the line under its name says it (VideoPage.tsx draws the rest).
    expect(await screen.findByText(/Answers in 6 ms · 1204 requests today, 3 failed/)).toBeTruthy();
    expect(screen.queryByText("Video is healthy")).toBeNull();
    expect(screen.getByRole("tablist", { name: "Video diagnostics" })).toBeTruthy();
  });

  it("shows only how to pair a container that isn't set up", async () => {
    render(<DiagnosticsPartPage part="faces" />);
    expect(await screen.findByText("Pairing")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});
