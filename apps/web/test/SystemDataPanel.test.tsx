import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn() }));

const { api } = await import("../src/api");
const { SystemDataPanel } = await import("../src/features/control/sections/storage/SystemDataPanel");
const mockApi = vi.mocked(api);

// System data (docs/system-data-plan.md, phase 2): chosen before the first
// library, confirmed with the exact folder, and the two folders that can live
// elsewhere changed from their own rows.

const idle = { running: false, done: 0, pending: 0, failed: [] };
const unset = {
  path: null,
  suggested: "C:\\iSputnik\\data",
  problem: "",
  database: "C:\\iSputnik\\data\\db\\isputnik.sqlite",
  space: { free: 30, total: 1000 },
  thumbnails: { path: null, source: null, problem: "", stats: { files: 0, bytes: 0, complete: true }, move: idle },
  backups: { path: "C:\\iSputnik\\data\\backups", source: "default", count: 0, bytes: 0, sameDiskAsDatabase: true, move: idle },
  metadata: { path: null, source: null, move: idle },
  moving: false
};
const set = {
  ...unset,
  path: "D:\\iSputnikData",
  space: { free: 3000, total: 4000 },
  thumbnails: { ...unset.thumbnails, path: "D:\\iSputnikData\\thumbnails", source: "system", stats: { files: 601, bytes: 48_000_000, complete: true } },
  backups: { ...unset.backups, path: "D:\\iSputnikData\\backups", source: "system", count: 3, bytes: 200_000_000, sameDiskAsDatabase: true },
  metadata: { path: "D:\\iSputnikData\\metadata", source: "system", move: idle }
};

let puts: { path: string; body: unknown }[] = [];

function mount(initial: object, space = { free: 30, total: 1000 }) {
  puts = [];
  let current = initial;
  mockApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (typeof path !== "string") return undefined;
    if (init?.method === "PUT") {
      puts.push({ path, body: JSON.parse(String(init.body)) });
      current = set;
      return set;
    }
    if (path === "/api/storage/system-data") return current;
    if (path.startsWith("/api/storage/disk-space")) return { space };
    throw new Error(`unexpected ${path}`);
  });
  render(<SystemDataPanel />);
}

beforeEach(() => { mockApi.mockReset(); });

describe("before system data is chosen", () => {
  it("suggests the folder next to the database, says no library can be made yet, and confirms the folder", async () => {
    const user = userEvent.setup();
    mount(unset);
    expect(await screen.findByText("No library can be created yet")).toBeInTheDocument();
    expect(screen.getByText(/Suggested: C:\\iSputnik\\data, the folder next to the database/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Use this folder" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Use C:\\iSputnik\\data for system data?")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Use this folder" }));
    await waitFor(() => expect(puts).toEqual([{ path: "/api/storage/system-data", body: { path: "C:\\iSputnik\\data" } }]));
    expect(await screen.findByText("D:\\iSputnikData")).toBeInTheDocument();
  });

  it("warns when the folder typed is on a disk that is almost full", async () => {
    const user = userEvent.setup();
    mount(unset, { free: 30, total: 1000 });
    await user.type(await screen.findByLabelText("Folder"), "C:\\small");
    expect(await screen.findByText("This disk is almost full")).toBeInTheDocument();
  });
});

describe("once system data is set", () => {
  it("lists the database, thumbnails, backups and metadata, and says when backups share the database's disk", async () => {
    mount(set, { free: 3000, total: 4000 });
    expect(await screen.findByText("C:\\iSputnik\\data\\db\\isputnik.sqlite")).toBeInTheDocument();
    expect(screen.getByText("D:\\iSputnikData\\thumbnails")).toBeInTheDocument();
    expect(screen.getByText(/601 files/)).toBeInTheDocument();
    expect(screen.getByText(/3 backups/)).toBeInTheDocument();
    expect(screen.getByText(/On the same disk as the database/)).toBeInTheDocument();
    expect(screen.queryByText("No library can be created yet")).toBeNull();
  });

  it("gives backups a folder of their own after a confirmation naming it", async () => {
    const user = userEvent.setup();
    mount(set, { free: 3000, total: 4000 });
    const row = (await screen.findByText("D:\\iSputnikData\\backups")).closest("tr") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Change" }));

    const chooser = await screen.findByRole("dialog");
    await user.click(within(chooser).getByText("A folder of their own"));
    await user.type(within(chooser).getByLabelText("Folder"), "E:\\offsite");
    await user.click(within(chooser).getByRole("button", { name: "Continue" }));

    const confirm = await screen.findByRole("dialog");
    expect(within(confirm).getByText("Keep backups in E:\\offsite?")).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Move backups" }));
    await waitFor(() => expect(puts).toEqual([{ path: "/api/storage/system-data/backups", body: { path: "E:\\offsite" } }]));
  });
});
