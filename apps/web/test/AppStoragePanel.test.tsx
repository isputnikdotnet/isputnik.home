import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn() }));

const { api } = await import("../src/api");
const { AppStoragePanel } = await import("../src/features/control/sections/storage/AppStoragePanel");
const { StorageSection } = await import("../src/features/control/sections/StorageSection");
const mockApi = vi.mocked(api);

// App storage (docs/system-data-plan.md, phase 3): one switch, where it lives, and
// four parts listed rather than switched. Every change is confirmed with the folder.

const idle = { running: false, done: 0, pending: 0, failed: [] };
const part = (name: string, extra: Record<string, unknown> = {}) => ({
  part: name, folder: null, inside: false, library: null, counts: {}, move: idle, renameTo: null, ...extra
});

const off = {
  enabled: false,
  where: "system",
  customPath: null,
  folder: "D:\\iSputnikData\\app-storage",
  systemFolder: "D:\\iSputnikData\\app-storage",
  systemDataSet: true,
  space: { free: 3000, total: 4000 },
  moving: false,
  offRefusal: null,
  parts: ["inbox", "house", "renders", "maps"].map((name) => part(name))
};

const root = "D:\\Media\\iSputnik";
const on = {
  ...off,
  enabled: true,
  where: "custom",
  customPath: root,
  folder: root,
  parts: [
    part("inbox", { folder: `${root}\\Photo Inbox`, inside: true, library: { id: "IN", name: "Photo Inbox" }, counts: { waiting: 7 } }),
    part("house", { folder: "D:\\Media\\Photos", inside: false, library: { id: "HF", name: "Photos" }, counts: { files: 52 } }),
    part("renders", { folder: `${root}\\Renders`, inside: true, counts: { tracks: 0 } }),
    part("maps", { folder: `${root}\\Map data`, inside: true })
  ],
  offRefusal: "7 photos are still waiting in the Photo Inbox. Keep or discard them first."
};

let posts: { path: string; body: unknown }[] = [];

function mount(view: object, Component: typeof AppStoragePanel | typeof StorageSection = AppStoragePanel) {
  posts = [];
  let current = view;
  mockApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (typeof path !== "string") return undefined;
    if (init?.method === "POST" || init?.method === "PUT") {
      posts.push({ path, body: init.body ? JSON.parse(String(init.body)) : null });
      current = { ...on, offRefusal: null };
      return current;
    }
    if (path === "/api/storage/app-storage") return current;
    if (path.startsWith("/api/storage/disk-space")) return { space: { free: 3000, total: 4000 } };
    if (path === "/api/storage/roots") return { roots: [] };
    if (path === "/api/storage/system-data") {
      return {
        path: "D:\\iSputnikData", suggested: "C:\\data", problem: "", database: "C:\\data\\db\\isputnik.sqlite", space: null,
        thumbnails: { path: "D:\\iSputnikData\\thumbnails", source: "system", problem: "", stats: { files: 0, bytes: 0, complete: true }, move: idle },
        backups: { path: "D:\\iSputnikData\\backups", source: "system", count: 0, bytes: 0, sameDiskAsDatabase: false, move: idle },
        metadata: { path: "D:\\iSputnikData\\metadata", source: "system", move: idle },
        moving: false
      };
    }
    throw new Error(`unexpected ${path}`);
  });
  render(<Component />);
}

beforeEach(() => { mockApi.mockReset(); });

describe("while off", () => {
  it("offers where it will live, and switches on after naming the folder", async () => {
    const user = userEvent.setup();
    mount(off);
    const toggle = await screen.findByRole("switch", { name: "App storage" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: /In system data/ })).toBeChecked();
    // Four parts listed, none with a switch of its own.
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    for (const name of ["Photo Inbox", "App files", "Renders", "Map data"]) expect(screen.getByText(name)).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /Custom folder/ }));
    await user.type(screen.getByLabelText("Folder"), root);
    await user.click(toggle);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(`Switch on App storage in ${root}?`)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Switch on App storage" }));
    await waitFor(() => expect(posts).toEqual([{ path: "/api/storage/app-storage/on", body: { where: "custom", path: root } }]));
  });

  it("says system data comes first when it is not chosen", async () => {
    mount({ ...off, systemDataSet: false, systemFolder: null, folder: null });
    expect(await screen.findByRole("switch", { name: "App storage" })).toBeDisabled();
    expect(screen.getByText("System data comes first")).toBeInTheDocument();
  });
});

describe("while on", () => {
  it("shows the folder, a part outside it with Move in, and why it will not switch off", async () => {
    const user = userEvent.setup();
    mount(on);
    expect(await screen.findByText(root)).toBeInTheDocument();
    expect(screen.getByText("7 photos waiting")).toBeInTheDocument();
    const house = screen.getByText("D:\\Media\\Photos").closest("tr") as HTMLElement;
    expect(within(house).getByText("Outside App storage")).toBeInTheDocument();
    expect(within(house).getByRole("link", { name: "Access" })).toHaveAttribute("href", "/control/libraries?edit=HF");

    await user.click(screen.getByRole("switch", { name: "App storage" }));
    const refusal = await screen.findByRole("alertdialog");
    expect(within(refusal).getByText(/7 photos are still waiting/)).toBeInTheDocument();
    expect(within(refusal).getByRole("button", { name: "Switch off App storage" })).toBeDisabled();
    await user.click(within(refusal).getByRole("button", { name: "Cancel" }));

    await user.click(within(house).getByRole("button", { name: "Move in" }));
    const confirm = await screen.findByRole("dialog");
    expect(within(confirm).getByText(`Move App files into ${root}?`)).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Move in" }));
    await waitFor(() => expect(posts).toEqual([{ path: "/api/storage/app-storage/parts/house/move-in", body: {} }]));
  });

  it("moves it to another folder after a confirmation naming it", async () => {
    const user = userEvent.setup();
    mount({ ...on, where: "custom" });
    await user.click(await screen.findByRole("button", { name: "Change" }));
    const chooser = await screen.findByRole("dialog");
    await user.click(within(chooser).getByRole("radio", { name: /In system data/ }));
    await user.click(within(chooser).getByRole("button", { name: "Continue" }));
    const confirm = await screen.findByRole("dialog");
    expect(within(confirm).getByText("Move App storage to D:\\iSputnikData\\app-storage?")).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Move App storage" }));
    await waitFor(() => expect(posts).toEqual([{ path: "/api/storage/app-storage", body: { where: "system", path: null } }]));
  });
});

describe("the Storage page", () => {
  it("shows containers, then System data, then App storage", async () => {
    mount(off, StorageSection);
    await screen.findByRole("switch", { name: "App storage" });
    const headings = Array.from(document.querySelectorAll("h2")).map((h) => h.textContent ?? "");
    const at = (text: string) => headings.findIndex((heading) => heading.startsWith(text));
    expect(at("Digital Library containers")).toBeLessThan(at("System data"));
    expect(at("System data")).toBeLessThan(at("App storage"));
    expect(screen.queryByText("Recycle Bin")).toBeNull();
  });
});
