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

beforeEach(() => {
  mockApi.mockReset();
  mockApi.mockImplementation(async (url: string) => {
    if (url.endsWith("/overview")) return { parts };
    if (url.endsWith("/logging")) return { level: "normal", until: null, minutes: [15, 60, 240] };
    if (url.includes("/api/admin/apps")) return { apps: [] };
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
    expect(await within(dialog).findByText(/version: 4\.90\.0/)).toBeTruthy();
    expect(within(dialog).queryByText(/gpu: vaapi/)).toBeNull();
    for (const name of [/Include names of people/, /Include folders and file paths/, /Include names of libraries/, /Include addresses/]) {
      expect(within(dialog).getByRole("switch", { name }).getAttribute("aria-checked")).toBe("false");
    }
    expect(mockApi).toHaveBeenCalledWith("/api/admin/diagnostics?hide=people,paths,names,net&since=day");
  });
});

describe("a container's page", () => {
  it("shows its connection and the requests through this server", async () => {
    render(<DiagnosticsPartPage part="video" />);
    expect(await screen.findByText("Video is healthy")).toBeTruthy();
    expect(screen.getByText(/1204 requests today, 3 failed/)).toBeTruthy();
  });
});
