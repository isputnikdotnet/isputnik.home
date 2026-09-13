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
  problem: "",
  ...extra
});

const view = {
  path: APP,
  ready: true,
  error: "",
  lockedBy: ["house", "renders"],
  rooms: [
    room("inbox", "off"),
    room("house", "app", { resolvedPath: `${APP}\\App files`, library: { id: "L1", name: "App files" } }),
    room("renders", "app", { resolvedPath: `${APP}\\Renders`, counts: { tracks: 0, clips: 0 } })
  ],
  libraries: []
};

/** System data, set: the block the page shows between containers and App storage. */
const systemData = {
  path: "D:\\iSputnikData",
  suggested: "C:\\iSputnik\\data",
  problem: "",
  database: "C:\\iSputnik\\data\\db\\isputnik.sqlite",
  space: { free: 1000, total: 4000 },
  thumbnails: { path: "D:\\iSputnikData\\thumbnails", source: "system", problem: "", stats: { files: 0, bytes: 0, complete: true }, move: { running: false, done: 0, pending: 0, failed: [] } },
  backups: { path: "D:\\iSputnikData\\backups", source: "system", count: 0, bytes: 0, sameDiskAsDatabase: false, move: { running: false, done: 0, pending: 0, failed: [] } },
  metadata: { path: "D:\\iSputnikData\\metadata", source: "system", move: { running: false, done: 0, pending: 0, failed: [] } },
  moving: false
};

/** The requests every mount makes besides App storage's own. */
function commonRead(path: string): unknown {
  if (path === "/api/storage/system-data") return systemData;
  if (path.startsWith("/api/storage/disk-space")) return { space: { free: 1000, total: 4000 } };
  return undefined;
}

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
    if (commonRead(path)) return commonRead(path);
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
    expect(within(dialog).getByText("The library's folder moves there with everything in it; nothing is rescanned.")).toBeInTheDocument();
    expect(within(dialog).getByText("Moved there as a task, checked file by file.")).toBeInTheDocument();
    // The list is real block markup inside the dialog, not text inside a paragraph.
    expect(document.querySelector("p .app-storage-options")).toBeNull();

    await user.click(boxes[0]);
    expect(within(dialog).getByText(`Stays at ${APP}\\App files as your own library.`)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Use this folder" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ path: "/api/storage/app-storage", body: { path: "D:\\Demo\\new", carry: { house: false } } });
  });

  it("clearing the folder names the rooms that leave it, with no tick to make", async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(screen.getByText(APP)).toBeInTheDocument());
    await user.click(appButtons().getByRole("button", { name: "Clear" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryAllByRole("checkbox")).toHaveLength(0);
    expect(within(dialog).getByText("App files")).toBeInTheDocument();
    expect(within(dialog).getByText(`Stays at ${APP}\\App files as your own library.`)).toBeInTheDocument();
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
      if (commonRead(path)) return commonRead(path);
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

// Since 4.6 the Recycle Bin, thumbnails and backups are not rooms of App storage
// (docs/system-data-plan.md): they are not listed here, and System data sits
// between the containers and App storage.
describe("what the page lists", () => {
  it("shows System data above App storage, and no bin, thumbnail or backup rooms", async () => {
    mount();
    expect(await screen.findByText("System data")).toBeInTheDocument();
    const headings = Array.from(document.querySelectorAll("h2")).map((h) => h.textContent ?? "");
    expect(headings.findIndex((text) => text.startsWith("System data"))).toBeLessThan(headings.findIndex((text) => text.startsWith("App storage")));
    const appRows = Array.from(document.querySelectorAll(".app-storage-rooms tbody tr")).map((row) => row.textContent ?? "");
    expect(appRows.some((text) => text.includes("Recycle Bin"))).toBe(false);
    expect(appRows.some((text) => text.includes("Backups"))).toBe(false);
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
      rooms: [...view.rooms, room("maps", "app", { resolvedPath: `${APP}\Map data`, holdsFiles: false })]
    };
    mockApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (typeof path !== "string") return undefined;
      if (init?.method === "PUT") {
        puts.push({ path, body: JSON.parse(String(init.body)) });
        return { storage: withMaps };
      }
      if (commonRead(path)) return commonRead(path);
      if (path === "/api/storage/app-storage") return withMaps;
      if (path === "/api/storage/roots") return { roots: [] };
      throw new Error(`unexpected ${path}`);
    });
    render(<StorageSection />);
  };

  it("is listed after Renders, last, and names where it is", async () => {
    mountWithMaps();
    const label = await screen.findByText("Map data");
    const rows = Array.from(document.querySelectorAll(".app-storage-rooms tbody tr")).map((row) => row.textContent ?? "");
    const at = (name: string) => rows.findIndex((text) => text.includes(name));
    expect(at("Map data")).toBe(at("Renders") + 1);
    expect(at("Map data")).toBe(rows.length - 1);
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
