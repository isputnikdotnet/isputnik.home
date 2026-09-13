import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn(), isAdminSession: () => true }));

const { api } = await import("../src/api");
const { WelcomePage } = await import("../src/pages/WelcomePage");
const mockApi = vi.mocked(api);

// The setup guide's Storage step. System data is the one answer it cannot be
// left without — no library can be added until thumbnails have somewhere to go —
// so the step shows the Storage page's own System data block, which says so where
// the choice is made (docs/system-data-plan.md, phase 2).

const user = {
  id: "u1",
  email: "admin@example.com",
  displayName: "Demo Admin",
  role: "admin" as const,
  theme: "dark" as const,
  protectedFromDelete: false,
  isActive: true,
  createdAt: "2026-09-01T00:00:00.000Z",
  deletedAt: null
};

const idle = { running: false, done: 0, pending: 0, failed: [] };
const systemData = (path: string | null, extra: Record<string, unknown> = {}) => ({
  path,
  suggested: "C:\\iSputnik\\data",
  problem: "",
  database: "C:\\iSputnik\\data\\db\\isputnik.sqlite",
  space: { free: 3000, total: 4000 },
  thumbnails: { path: path ? `${path}\\thumbnails` : null, source: path ? "system" : null, problem: "", stats: { files: 0, bytes: 0, complete: true }, move: idle },
  backups: { path: "C:\\iSputnik\\data\\backups", source: path ? "system" : "default", count: 0, bytes: 0, sameDiskAsDatabase: false, move: idle },
  metadata: { path: null, source: null, move: idle },
  moving: false,
  ...extra
});

const appStorageOff = {
  enabled: false, where: "system", customPath: null, folder: "D:\\iSputnikData\\app-storage", systemFolder: "D:\\iSputnikData\\app-storage",
  systemDataSet: true, space: { free: 3000, total: 4000 }, moving: false, offRefusal: null,
  parts: ["inbox", "house", "renders", "maps"].map((part) => ({
    part, folder: null, inside: false, library: null, counts: {}, renameTo: null,
    move: { running: false, done: 0, pending: 0, failed: [] }
  }))
};

function mount(system: ReturnType<typeof systemData>) {
  mockApi.mockImplementation(async (path: string) => {
    if (typeof path !== "string") return undefined;
    if (path === "/api/library/settings") {
      return { settings: { thumbnailPath: system.thumbnails.path ?? "", thumbnailPathReady: Boolean(system.path), thumbnailPathError: "", fromEnvironment: false } };
    }
    if (path === "/api/storage/roots") return { roots: [{ id: "r1", name: "Demo", path: "D:\\Demo" }] };
    if (path === "/api/storage/system-data") return system;
    if (path.startsWith("/api/storage/disk-space")) return { space: { free: 3000, total: 4000 } };
    if (path === "/api/storage/app-storage") return appStorageOff;
    return null;
  });
  render(<WelcomePage user={user} onDone={() => {}} />);
}

const noLibraryYet = "No library can be created yet";

beforeEach(() => { mockApi.mockReset(); });

describe("the setup guide's Storage step", () => {
  it("asks for system data, and says no library can be made until it is chosen", async () => {
    mount(systemData(null));
    expect(await screen.findByText(noLibraryYet)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use this folder" })).toBeInTheDocument();
  });

  it("shows what is wrong with the folder that is set", async () => {
    mount(systemData("D:\\iSputnikData", { problem: "That path is a file, not a folder." }));
    expect(await screen.findByText("That path is a file, not a folder.")).toBeInTheDocument();
    expect(screen.queryByText(noLibraryYet)).toBeNull();
  });

  it("says no more once system data is set, and leaves App storage to its own step", async () => {
    mount(systemData("D:\\iSputnikData"));
    await waitFor(() => expect(screen.getByText("D:\\iSputnikData")).toBeInTheDocument());
    expect(screen.queryByText(noLibraryYet)).toBeNull();
    expect(screen.queryByRole("switch", { name: "App storage" })).toBeNull();
  });

  it("offers App storage as its own step, off, with In system data chosen", async () => {
    const user = userEvent.setup();
    mount(systemData("D:\\iSputnikData"));
    await user.click(screen.getByRole("button", { name: /^App storage/ }));
    expect(await screen.findByRole("switch", { name: "App storage" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: /In system data/ })).toBeChecked();
  });
});

// The Maps step: the Maps page's own cards, so the guide and the control panel
// can never disagree about what is on. Never locked — maps work with nothing kept.
describe("the setup guide's Maps step", () => {
  const mapSettings = {
    settings: { cache: true, cacheLimitMb: 200 },
    cache: { folder: "D:\Demo\iSputnik\Map data", path: "D:\Demo\iSputnik\Map data\Tiles", bytes: 0, limitBytes: 200 * 1024 * 1024 },
    locations: {
      available: false, tier: null, databaseType: null, buildDate: null, updatedAt: null, sizeBytes: null,
      directory: "D:\Demo\iSputnik\Map data\Locations", databases: [], countryFilePresent: false, source: "DB-IP"
    },
    places: {
      present: false, sizeBytes: 0, builtAt: null, sourceDate: null, places: 0,
      build: { running: false, jobId: null, stage: null, done: 0, total: 0, error: null, finishedAt: null }
    }
  };

  it("shows the four map features with their switches, as they are", async () => {
    const user = userEvent.setup();
    mockApi.mockImplementation(async (path: string) => {
      if (path === "/api/map/settings") return mapSettings;
      if (path === "/api/config/routing") return { routing: { endpoint: "", hasApiKey: false }, configured: false };
      return null;
    });
    render(<WelcomePage user={{ id: "u1", email: "admin@example.com", displayName: "Demo Admin", role: "admin", theme: "dark", protectedFromDelete: false, isActive: true, createdAt: "2026-09-01T00:00:00.000Z", deletedAt: null }} onDone={() => {}} />);

    await user.click(screen.getByRole("button", { name: /^Maps/ }));
    const switchOf = async (title: string) =>
      within((await screen.findByRole("heading", { name: new RegExp(`^${title}`) })).closest("section") as HTMLElement).getByRole("switch");
    expect(await switchOf("Offline maps")).toHaveAttribute("aria-checked", "true");
    expect(await switchOf("Photo place names")).toHaveAttribute("aria-checked", "false");
    expect(await switchOf("Sign-in locations")).toHaveAttribute("aria-checked", "false");
    expect(await switchOf("Road routes")).toHaveAttribute("aria-checked", "false");
  });
});
