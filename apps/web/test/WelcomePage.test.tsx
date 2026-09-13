import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn(), isAdminSession: () => true }));

const { api } = await import("../src/api");
const { WelcomePage } = await import("../src/pages/WelcomePage");
const mockApi = vi.mocked(api);

// The setup guide's Storage step. Thumbnails are the one answer it cannot be
// left without — no library can be added until they have a folder — so the step
// says so where the choice is made, instead of leaving the admin to meet a
// greyed-out Add library button on another page.

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

const roomOf = (mode: "app" | "own" | "off", extra: Record<string, unknown> = {}) => ({
  room: "thumbnails",
  mode,
  appPath: "D:\Demo\iSputnik\Thumbnails",
  library: null,
  counts: {},
  required: true,
  problem: "",
  ...extra
});

function mount(thumbnails: ReturnType<typeof roomOf>, thumbnailPath = "D:\Demo\thumbs") {
  mockApi.mockImplementation(async (path: string) => {
    if (typeof path !== "string") return undefined;
    if (path === "/api/library/settings") {
      return { settings: { thumbnailPath, thumbnailPathReady: true, thumbnailPathError: "", fromEnvironment: false } };
    }
    if (path === "/api/storage/roots") return { roots: [{ id: "r1", name: "Demo", path: "D:\Demo" }] };
    if (path === "/api/storage/app-storage") return { path: "D:\Demo\iSputnik", rooms: [thumbnails] };
    return null;
  });
  render(<WelcomePage user={user} onDone={() => {}} />);
}

const needsAFolder = "Thumbnails have nowhere to go yet. Choose App storage above, or give them a folder of their own below — no library can be added until they have one.";

beforeEach(() => { mockApi.mockReset(); });

describe("the setup guide's Storage step", () => {
  it("says thumbnails need a folder while the room is off", async () => {
    mount(roomOf("off"), "");
    expect(await screen.findByText(needsAFolder)).toBeInTheDocument();
  });

  it("shows what is wrong with the folder that is set", async () => {
    mount(roomOf("own", { problem: "That path is a file, not a folder." }));
    expect(await screen.findByText("That path is a file, not a folder.")).toBeInTheDocument();
    expect(screen.queryByText(needsAFolder)).toBeNull();
  });

  it("says neither once thumbnails have a place", async () => {
    mount(roomOf("app"));
    await waitFor(() => expect(screen.getByText("Kept here: Thumbnails.")).toBeInTheDocument());
    expect(screen.queryByText(needsAFolder)).toBeNull();
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
