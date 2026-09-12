import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn() }));

const { api } = await import("../src/api");
const { StorageSection } = await import("../src/features/control/sections/StorageSection");
const mockApi = vi.mocked(api);

// Changing the App storage folder while rooms use it (docs/app-storage-plan.md,
// decision 4 as amended): the confirmation lists those rooms, each with a tick
// that means "carry it to the new folder", and says what leaving one means.

const APP = "D:\\Demo\\iSputnik";
const room = (name: string, mode: "app" | "own" | "off", extra: Record<string, unknown> = {}) => ({
  room: name,
  mode,
  resolvedPath: mode === "off" ? null : `${APP}\\${name}`,
  appPath: `${APP}\\${name}`,
  holdsFiles: mode === "app",
  library: null,
  counts: {},
  move: { running: false, jobId: null, label: null, from: null, to: null, done: 0, pending: 0, failed: [] },
  renameTo: null,
  required: name === "thumbnails",
  problem: "",
  ...extra
});

const view = {
  path: APP,
  ready: true,
  error: "",
  lockedBy: ["trash", "renders"],
  rooms: [
    room("trash", "app", { resolvedPath: `${APP}\\Recycle Bin`, counts: { itemsInBin: 10 } }),
    room("inbox", "off"),
    room("house", "off"),
    room("thumbnails", "own", { resolvedPath: "D:\\Demo\\thumbs" }),
    room("renders", "app", { resolvedPath: `${APP}\\Renders`, counts: { tracks: 0, clips: 0 } }),
    room("backups", "own", { resolvedPath: "D:\\backups", counts: { backups: 0 } })
  ],
  libraries: []
};

let puts: { path: string; body: unknown }[] = [];

function mount() {
  puts = [];
  mockApi.mockImplementation(async (path: string, init?: RequestInit) => {
    // The harness calls the mock once with no arguments between tests.
    if (typeof path !== "string") return undefined;
    if (init?.method === "PUT") {
      puts.push({ path, body: JSON.parse(String(init.body)) });
      return view;
    }
    if (path === "/api/storage/app-storage") return view;
    if (path === "/api/storage/roots") return { roots: [{ id: "r1", name: "Demo", path: "D:\\Demo" }] };
    if (path.startsWith("/api/storage/roots/r1/browse")) {
      return { root: { id: "r1", name: "Demo", path: "D:\\Demo" }, currentPath: "new", selectedPath: "D:\\Demo\\new", parentPath: null, entries: [] };
    }
    throw new Error(`unexpected ${path}`);
  });
  render(<StorageSection />);
}

const appButtons = () => within(document.querySelector(".app-storage-buttons") as HTMLElement);

beforeEach(() => { mockApi.mockReset(); });

describe("changing the App storage folder while rooms use it", () => {
  it("lists each room in use with a tick, tells what leaving it means, and sends the choices", async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(screen.getByText(APP)).toBeInTheDocument());
    await user.click(appButtons().getByRole("button", { name: "Change" }));
    await user.click(await screen.findByRole("button", { name: "Use this folder" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Use D:\\Demo\\new as App storage?")).toBeInTheDocument();
    const boxes = within(dialog).getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    expect(boxes.every((box) => (box as HTMLInputElement).checked)).toBe(true);
    expect(within(dialog).getByText("The 10 items in the bin are moved there in the background.")).toBeInTheDocument();
    expect(within(dialog).getByText("Moved there as a task, checked file by file.")).toBeInTheDocument();
    // The list is real block markup inside the dialog, not text inside a paragraph.
    expect(document.querySelector("p .app-storage-options")).toBeNull();

    await user.click(boxes[0]);
    expect(within(dialog).getByText(`Keeps ${APP}\\Recycle Bin as its own folder.`)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Use this folder" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ path: "/api/storage/app-storage", body: { path: "D:\\Demo\\new", carry: { trash: false } } });
  });

  it("clearing the folder names the rooms that leave it, with no tick to make", async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(screen.getByText(APP)).toBeInTheDocument());
    await user.click(appButtons().getByRole("button", { name: "Clear" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryAllByRole("checkbox")).toHaveLength(0);
    expect(within(dialog).getByText("Recycle Bin")).toBeInTheDocument();
    expect(within(dialog).getByText(`Keeps ${APP}\\Recycle Bin as its own folder.`)).toBeInTheDocument();
    expect(within(dialog).getByText("Goes back inside the thumbnail folder.")).toBeInTheDocument();
    expect(document.querySelector("p .app-storage-stays")).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].body).toEqual({ path: null, carry: {} });
  });
});

// An install that made the App files room as "Made in the app" keeps that
// folder; the row offers to rename it, and the rename is confirmed with the
// exact folders before anything is queued.
describe("renaming the App files folder from its former name", () => {
  it("shows Rename folder only on the row under a former name, confirms, and posts the rename", async () => {
    const user = userEvent.setup();
    const legacyView = {
      ...view,
      rooms: view.rooms.map((r) => r.room === "house"
        ? room("house", "app", { resolvedPath: `${APP}\\Made in the app`, library: { id: "L1", name: "Random" }, renameTo: `${APP}\\App files` })
        : r)
    };
    const posts: string[] = [];
    mockApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (typeof path !== "string") return undefined;
      if (init?.method === "POST") { posts.push(path); return { storage: legacyView }; }
      if (path === "/api/storage/app-storage") return legacyView;
      if (path === "/api/storage/roots") return { roots: [] };
      throw new Error(`unexpected ${path}`);
    });
    render(<StorageSection />);
    await waitFor(() => expect(screen.getByText(`${APP}\\Made in the app`)).toBeInTheDocument());

    const renames = screen.getAllByRole("button", { name: "Rename folder" });
    expect(renames).toHaveLength(1);
    await user.click(renames[0]);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Rename the folder to App files?")).toBeInTheDocument();
    expect(within(dialog).getByText(/D:\\Demo\\iSputnik\\Made in the app becomes D:\\Demo\\iSputnik\\App files\. The library "Random" follows its folder/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Rename folder" }));
    await waitFor(() => expect(posts).toEqual(["/api/storage/app-storage/rooms/house/rename"]));
  });
});

// Thumbnails are the one room that cannot be left without a folder: no library
// can be added until they have one, so the row says so rather than reading like
// the optional rooms beside it.
describe("the Thumbnails row when it has nowhere to go", () => {
  const mountWith = (thumbnails: Record<string, unknown>) => {
    const withRoom = { ...view, rooms: view.rooms.map((r) => (r.room === "thumbnails" ? { ...r, ...thumbnails } : r)) };
    mockApi.mockImplementation(async (path: string) => {
      if (typeof path !== "string") return undefined;
      if (path === "/api/storage/app-storage") return withRoom;
      if (path === "/api/storage/roots") return { roots: [] };
      throw new Error(`unexpected ${path}`);
    });
    render(<StorageSection />);
  };

  it("says a folder is needed while the room is off", async () => {
    mountWith({ mode: "off", resolvedPath: null });
    expect(await screen.findByText("A folder is needed before a library can be added.")).toBeInTheDocument();
  });

  it("shows the folder's own problem instead of waiting for a scan to fail", async () => {
    mountWith({ problem: "Thumbnail path must be a directory." });
    expect(await screen.findByText("Thumbnail path must be a directory.")).toBeInTheDocument();
    expect(screen.queryByText("A folder is needed before a library can be added.")).toBeNull();
  });

  it("says neither while the folder is fine", async () => {
    mountWith({});
    await waitFor(() => expect(screen.getByText("D:\\Demo\\thumbs")).toBeInTheDocument());
    expect(screen.queryByText("A folder is needed before a library can be added.")).toBeNull();
  });
});

// The Map data room (docs/map-approach-proposal.md, phase 1b): the Renders
// pattern, so App storage or its own folder and nothing else. Off is not a
// storage question — whether maps are kept at all is chosen with maps.
describe("the Map data row", () => {
  const mountWithMaps = () => {
    puts = [];
    const withMaps = {
      ...view,
      rooms: [...view.rooms.slice(0, 5), room("maps", "app", { resolvedPath: `${APP}\Map data`, holdsFiles: false }), view.rooms[5]]
    };
    mockApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (typeof path !== "string") return undefined;
      if (init?.method === "PUT") {
        puts.push({ path, body: JSON.parse(String(init.body)) });
        return { storage: withMaps };
      }
      if (path === "/api/storage/app-storage") return withMaps;
      if (path === "/api/storage/roots") return { roots: [] };
      throw new Error(`unexpected ${path}`);
    });
    render(<StorageSection />);
  };

  it("is listed between Renders and Backups, and names where it is", async () => {
    mountWithMaps();
    const label = await screen.findByText("Map data");
    const rows = Array.from(document.querySelectorAll("tbody tr")).map((row) => row.textContent ?? "");
    const at = (name: string) => rows.findIndex((text) => text.includes(name));
    expect(at("Map data")).toBe(at("Renders") + 1);
    expect(at("Backups")).toBe(at("Map data") + 1);
    expect(within(label.closest("tr") as HTMLElement).getByText(`${APP}\Map data`)).toBeInTheDocument();
  });

  it("offers App storage or its own folder — never off — and confirms before switching", async () => {
    const user = userEvent.setup();
    mountWithMaps();
    const row = (await screen.findByText("Map data")).closest("tr") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Change" }));

    const chooser = await screen.findByRole("dialog");
    const options = within(chooser).getAllByRole("radio");
    expect(options.map((option) => (option as HTMLInputElement).value)).toEqual(["app", "own"]);
    expect(within(chooser).getByText("Its own folder")).toBeInTheDocument();
    await user.click(within(chooser).getByText("Its own folder"));
    await user.click(within(chooser).getByRole("button", { name: "Continue" }));

    const confirm = await screen.findByRole("dialog");
    expect(within(confirm).getByText("Keep map data in its own folder?")).toBeInTheDocument();
    expect(within(confirm).getByText(/What is already kept moves now, as a task/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Use it" }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ path: "/api/storage/app-storage/rooms/maps", body: { mode: "own", path: null, libraryId: null } });
  });
});
