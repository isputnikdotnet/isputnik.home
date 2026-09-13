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

// The Maps step: what this server keeps for maps, and the same wizard Maps › Setup
// opens. Never locked — maps work with nothing kept.
describe("the setup guide's Maps step", () => {
  const mapSettings = {
    settings: { cache: true },
    cache: { folder: "D:\\Demo\\iSputnik\\Map data", path: "D:\\Demo\\iSputnik\\Map data\\Tiles", bytes: 0 },
    locations: {
      available: false, tier: null, databaseType: null, buildDate: null, updatedAt: null, sizeBytes: null,
      directory: "D:\\Demo\\iSputnik\\Map data\\Locations", databases: [], countryFilePresent: false, source: "DB-IP"
    },
    places: {
      present: false, sizeBytes: 0, builtAt: null, sourceDate: null, places: 0,
      build: { running: false, jobId: null, stage: null, done: 0, total: 0, error: null, finishedAt: null }
    }
  };

  it("shows each level as it is, and opens the setup wizard with only what is off", async () => {
    const user = userEvent.setup();
    mockApi.mockImplementation(async (path: string) => {
      if (path === "/api/map/settings") return mapSettings;
      return null;
    });
    render(<WelcomePage user={{ id: "u1", email: "admin@example.com", displayName: "Demo Admin", role: "admin", theme: "dark", protectedFromDelete: false, isActive: true, createdAt: "2026-09-01T00:00:00.000Z", deletedAt: null }} onDone={() => {}} />);

    await user.click(screen.getByRole("button", { name: /^Maps/ }));
    const cache = (await screen.findByText("Maps on this server")).closest("li") as HTMLElement;
    expect(within(cache).getByText("On")).toBeInTheDocument();
    expect(within(screen.getByText("Named places").closest("li") as HTMLElement).getByText("Off")).toBeInTheDocument();
    expect(within(screen.getByText("Sign-in countries").closest("li") as HTMLElement).getByText("Off")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Set up maps" }));
    const dialog = await screen.findByRole("dialog");
    const boxes = within(dialog).getAllByRole("checkbox") as HTMLInputElement[];
    // The cache is already on; named places and countries are offered.
    expect(boxes.map((box) => [box.checked, box.disabled])).toEqual([[true, true], [true, false], [true, false]]);
  });
});
