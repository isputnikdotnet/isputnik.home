import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { controlHref, navigate } from "../src/router";
import { BackupSection } from "../src/features/control/sections/BackupSection";
import { formatManagedDate } from "../src/shared/utils";
import { backupHref } from "../src/features/control/links";

vi.mock("../src/api", () => ({ api: vi.fn() }));
const mockApi = vi.mocked(api);
const at = (path: string) => window.history.replaceState({}, "", path);
const location = () => window.location.pathname + window.location.search;

function fixture() {
  return {
    backups: [12, 11, 10, 9].map((day) => ({
      name: `isputnik-2026-11-${day}-minimal.zip`, sizeBytes: 3500,
      createdAt: `2026-11-${String(day).padStart(2, "0")}T10:00:00.000Z`, kind: "minimal"
    })),
    backupPath: "D:/server/backups", settings: { retention: { full: 2, minimal: 10, database: 2 } },
    coversAvailable: true, totalSizeBytes: 14000, runningSince: null as string | null,
    runningKind: null as string | null, lastError: null as string | null
  };
}
let data = fixture();
let unavailable = false;
const jobs = ["full", "minimal"].map((kind) => ({
  key: `backup_${kind}`, label: kind, enabled: true, frequency: "daily", time: "02:00",
  dayOfWeek: 0, dayOfMonth: 1, nextRunAt: kind === "minimal" ? "2026-11-13T02:00:00Z" : "2026-11-14T02:00:00Z",
  lastRunAt: null, lastStatus: null, lastMessage: null
}));
const appFiles = ["own", "full"].map((source, index) => ({
  name: `${source}.sqlite`, source, sizeBytes: 1000, createdAt: `2026-11-${12 - index}T09:00:00Z`, version: "4.86.0"
}));

beforeEach(() => {
  at(controlHref("backup"));
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  data = fixture();
  unavailable = false;
  mockApi.mockReset();
  mockApi.mockImplementation(async (path, options) => {
    if (path === "/api/backups") return data;
    if (path === "/api/scheduled-jobs") {
      if (unavailable) throw new Error("Schedule service unavailable");
      return { jobs };
    }
    if (path === "/api/backups/apps") return { apps: [
      { id: "games", configured: true, problem: null, include: true, keep: 2, files: appFiles, restoreSupported: true, undo: null },
      { id: "video", configured: false, problem: null, include: true, keep: 2, files: [], restoreSupported: null, undo: null }
    ] };
    if (path === "/api/backups/settings" && options?.method === "PATCH") {
      Object.assign(data.settings.retention, JSON.parse(String(options.body)).retention);
      return {};
    }
    if (path.startsWith("/api/backups/isputnik-") && options?.method === "DELETE") {
      data.backups = data.backups.filter((file) => !path.endsWith(encodeURIComponent(file.name)));
      return {};
    }
    throw new Error(`Unexpected API call: ${options?.method ?? "GET"} ${path}`);
  });
});

describe("Backup overview and details", () => {
  it("shows three recent files and compact applications, with full lists behind rows", async () => {
    render(<BackupSection />);
    await screen.findByText("Latest available backup");
    const recent = screen.getByRole("region", { name: "Recent backups" });
    expect(within(recent).getAllByRole("button")).toHaveLength(4);
    expect(within(recent).queryByText(formatManagedDate(data.backups[3].createdAt))).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Next scheduled backup/ })).toHaveTextContent(formatManagedDate(jobs[1].nextRunAt));
    expect(screen.queryByText(data.backupPath)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /All backups/ }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("All backups");
    expect(screen.getByText(formatManagedDate(data.backups[3].createdAt))).toBeInTheDocument();
  });

  it("returns through the schedule to Backup, then to the originating application tab", async () => {
    const origin = `${controlHref("videoSettings")}?section=quality`;
    at(origin);
    navigate(controlHref("backup"));
    render(<BackupSection />);
    await userEvent.click(await screen.findByRole("button", { name: /Next scheduled backup/ }));
    expect(new URLSearchParams(window.location.search).get("show")).toBe("job:backup_minimal");
    await userEvent.click(screen.getByRole("link", { name: "Back" }));
    await waitFor(() => expect(location()).toBe(controlHref("backup")));
    await userEvent.click(screen.getByRole("link", { name: "Back" }));
    await waitFor(() => expect(location()).toBe(origin));
  });

  it("returns a file opened from All backups to that list without creating a loop", async () => {
    render(<BackupSection />);
    await userEvent.click(await screen.findByRole("button", { name: /All backups/ }));
    const allPath = location();
    await userEvent.click(screen.getByRole("button", { name: new RegExp(formatManagedDate(data.backups[3].createdAt)) }));
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("download");
    await userEvent.click(screen.getByRole("link", { name: "Back" }));
    await waitFor(() => expect(location()).toBe(allPath));
    await userEvent.click(screen.getByRole("link", { name: "Back" }));
    await waitFor(() => expect(location()).toBe(controlHref("backup")));
  });

  it("uses the settings fallback for a direct visit without leaving a detail in history", async () => {
    at(`${controlHref("backup")}?show=retention`);
    render(<BackupSection />);
    await screen.findByRole("spinbutton", { name: "Database copy" });
    await userEvent.click(screen.getByRole("link", { name: "Back" }));
    expect(location()).toBe(controlHref("backup"));
    await userEvent.click(screen.getByRole("link", { name: "Back" }));
    expect(location()).toBe(controlHref("appearance"));
  });

  it("edits retention independently for each kind", async () => {
    render(<BackupSection />);
    await userEvent.click(await screen.findByRole("button", { name: /Retention/ }));
    const field = screen.getByRole("spinbutton", { name: "Database copy" });
    fireEvent.change(field, { target: { value: "7" } });
    fireEvent.blur(field);
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/api/backups/settings", {
      method: "PATCH", body: JSON.stringify({ retention: { database: 7 } })
    }));
    expect(data.settings.retention.full).toBe(2);
    expect(data.settings.retention.minimal).toBe(10);
  });

  it("never offers restore, download or delete for an unfinished file", async () => {
    data.runningSince = data.backups[0].createdAt;
    data.runningKind = "minimal";
    at(`${controlHref("backup")}?show=${encodeURIComponent(`backup:${data.backups[0].name}`)}`);
    render(<BackupSection />);
    await screen.findByText(data.backups[0].name);
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete backup" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Download" })).not.toBeInTheDocument();
  });

  it("shows a schedule error instead of claiming scheduling is off", async () => {
    unavailable = true;
    render(<BackupSection />);
    await screen.findByText("Schedule service unavailable");
    expect(screen.getByRole("button", { name: /Next scheduled backup/ })).toHaveTextContent("Unavailable");
    expect(screen.getByRole("button", { name: /Next scheduled backup/ })).toBeDisabled();
  });

  it("opens application backups and keeps files from a Home archive undeletable", async () => {
    render(<BackupSection />);
    await userEvent.click(await screen.findByRole("button", { name: /^Games/ }));
    await screen.findByRole("heading", { level: 1, name: "Games" });
    const appPath = location();
    await userEvent.click(screen.getByRole("button", { name: /Inside a full backup/ }));
    expect(screen.getByRole("button", { name: "Restore" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Delete backup" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Back" }));
    await waitFor(() => expect(location()).toBe(appPath));
    await userEvent.click(screen.getByRole("button", { name: /Its own backup/ }));
    expect(screen.getByRole("button", { name: "Delete backup" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(mockApi.mock.calls.some(([path]) => path.endsWith("/restore"))).toBe(false);
  });

  it("keeps legacy container links and their originating page working", async () => {
    at(controlHref("dashboard"));
    navigate(`${controlHref("backup")}#container-backup-games`);
    render(<BackupSection />);
    await screen.findByRole("heading", { level: 1, name: "Games" });
    expect(location()).toBe(backupHref("games"));
    await userEvent.click(screen.getByRole("link", { name: "Back" }));
    await waitFor(() => expect(location()).toBe(controlHref("dashboard")));
  });

  it("supports the browser's own Back through application file details", async () => {
    render(<BackupSection />);
    await userEvent.click(await screen.findByRole("button", { name: /^Games/ }));
    await screen.findByRole("heading", { level: 1, name: "Games" });
    const appPath = location();
    await userEvent.click(screen.getByRole("button", { name: /Its own backup/ }));
    act(() => window.history.back());
    await waitFor(() => expect(location()).toBe(appPath));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Games");
    expect(screen.getByRole("button", { name: /Its own backup/ })).toBeInTheDocument();
  });

  it("deletes only after confirmation and returns to the list without reopening the deleted file", async () => {
    const origin = controlHref("dashboard");
    at(origin);
    navigate(controlHref("backup"));
    render(<BackupSection />);
    await userEvent.click(await screen.findByRole("button", { name: /All backups/ }));
    const allPath = location();
    await userEvent.click(screen.getByRole("button", { name: new RegExp(formatManagedDate(data.backups[0].createdAt)) }));
    const name = data.backups[0].name;
    await userEvent.click(screen.getByRole("button", { name: "Delete backup" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(mockApi.mock.calls.some(([, options]) => options?.method === "DELETE")).toBe(false);
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete backup" }));
    await waitFor(() => expect(location()).toBe(allPath));
    expect(data.backups.some((file) => file.name === name)).toBe(false);
    await userEvent.click(screen.getByRole("link", { name: "Back" }));
    await waitFor(() => expect(location()).toBe(controlHref("backup")));
    await userEvent.click(screen.getByRole("link", { name: "Back" }));
    await waitFor(() => expect(location()).toBe(origin));
  });
});
