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

beforeEach(() => mockApi.mockReset());

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
