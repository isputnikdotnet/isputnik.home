import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn() }));

const { api } = await import("../src/api");
const { AppStoragePanel } = await import("../src/features/control/sections/storage/AppStoragePanel");
const { StorageSection, driveOf } = await import("../src/features/control/sections/StorageSection");
const { PhotoInboxCard } = await import("../src/features/control/sections/storage/PhotoInboxCard");
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
const reviewers = {
  reviewers: [{ subjectType: "user", subjectId: "mia", name: "Mia", email: "mia@home", level: "details", missing: false }],
  everyone: null,
  candidates: { users: [{ id: "mia", name: "Mia" }, { id: "olga", name: "Olga" }], groups: [] }
};

// The Inbox as the manage listing returns it: a system library with the admin
// settings the Scanning dialog must send back unchanged.
const scanSources = [{ id: "file_metadata", enabled: true }, { id: "folder_structure", enabled: false }];
const inboxLibrary = {
  id: "IN", name: "Photo Inbox", type: "gallery", role: "inbox", visibility: "private", publicRole: "member", mode: "managed",
  ownerId: null, ownerType: null,
  settings: { defaultLanguage: "en", scanExtensions: [".jpg", ".png"], companionExtensions: [".xmp"], scanSources, maxUploadMB: 512, tagEncoding: null, progressMode: "linear" }
};
const librarySettings = {
  settings: {},
  metadataSources: [
    { id: "file_metadata", label: "File metadata", description: "Dates and places inside the files.", appliesTo: ["gallery"], defaultEnabled: true },
    { id: "folder_structure", label: "Folder names", description: "", appliesTo: ["gallery"], defaultEnabled: false },
    { id: "metadata_files", label: "Sidecar files", description: "", appliesTo: ["audiobook"], defaultEnabled: true }
  ],
  typeDefaults: { gallery: { extensions: [".jpg"], companions: [], sources: scanSources } }
};

let roots: object[] = [];

function mount(view: object, Component: typeof AppStoragePanel | typeof StorageSection | typeof PhotoInboxCard = AppStoragePanel) {
  posts = [];
  let current = view;
  mockApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (typeof path !== "string") return undefined;
    if (init?.method === "DELETE") { posts.push({ path, body: null }); return { ok: true }; }
    if (init?.method === "POST" || init?.method === "PUT" || init?.method === "PATCH") {
      posts.push({ path, body: init.body ? JSON.parse(String(init.body)) : null });
      if (path.includes("/reviewers")) return reviewers;
      if (init.method === "PATCH") return { library: inboxLibrary };
      current = { ...on, offRefusal: null };
      return current;
    }
    if (path === "/api/storage/app-storage") return current;
    if (path === "/api/storage/app-storage/parts/inbox/reviewers") return reviewers;
    if (path === "/api/library/settings") return librarySettings;
    if (path === "/api/library/gallery-libraries?manage=1") return { libraries: [inboxLibrary] };
    if (path.startsWith("/api/storage/disk-space")) return { space: { free: 3000, total: 4000 } };
    if (path === "/api/storage/roots") return { roots };
    if (path === "/api/storage/personal-libraries") return { settings: { enabled: false }, parentFolder: null, libraries: [] };
    if (path === "/api/apps/admin/status") return { apps: [] };
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

beforeEach(() => { mockApi.mockReset(); roots = []; });

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
    expect(screen.getByText("7 photos waiting · admins review")).toBeInTheDocument();
    const house = screen.getByText("D:\\Media\\Photos").closest(".storage-part") as HTMLElement;
    expect(within(house).getByText("Outside App storage")).toBeInTheDocument();
    // No access rules on either system library: App files follows its owners.
    expect(within(house).queryByRole("link", { name: "Access" })).toBeNull();

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

  it("names the Inbox reviewers, and leads to its settings on Gallery › Settings", async () => {
    mount({ ...on, parts: on.parts.map((p) => p.part === "inbox" ? { ...p, counts: { waiting: 7, reviewers: 1 } } : p) });
    const inbox = (await screen.findByText("7 photos waiting · 1 reviewer")).closest(".storage-part") as HTMLElement;
    expect(within(inbox).queryByRole("link", { name: "Access" })).toBeNull();
    // Reviewers and Scanning are the Inbox's settings, not storage: a link, not dialogs.
    expect(within(inbox).getByRole("link", { name: /Reviewers and scanning/ })).toHaveAttribute("href", "/control/apps/gallery/settings#photo-inbox");
    expect(within(inbox).queryByRole("button", { name: "Scanning" })).toBeNull();
  });

  it("sets the Inbox reviewers from Gallery › Settings", async () => {
    const user = userEvent.setup();
    mount(on, PhotoInboxCard);
    await user.click(await screen.findByRole("button", { name: /^Reviewers/ }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Mia")).toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: "Role for Mia" })).toHaveValue("details");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Role for Mia" }), "keep");
    await waitFor(() => expect(posts).toEqual([{ path: "/api/storage/app-storage/parts/inbox/reviewers", body: { subjectType: "user", subjectId: "mia", level: "keep" } }]));
  });

  it("opens the Inbox's Scanning settings and saves them with its other settings untouched", async () => {
    const user = userEvent.setup();
    mount(on, PhotoInboxCard);
    await user.click(await screen.findByRole("button", { name: /^Scanning/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Photo Inbox scanning")).toBeInTheDocument();
    // The Scanning tab's two editors: gallery scan sources only, and the back-sides rule
    // with the dry run (so the library id reached it).
    expect(await within(dialog).findByText("File metadata")).toBeInTheDocument();
    expect(within(dialog).queryByText("Sidecar files")).toBeNull();
    expect(within(dialog).getByText("Back sides")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Check this library" })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("checkbox", { name: "Enable Epson FastFoto" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Enable Folder names" }));
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(posts).toEqual([{
      path: "/api/library/gallery-libraries/IN",
      body: {
        name: "Photo Inbox", visibility: "private", publicRole: "member", mode: "managed", ownerId: null, ownerType: null,
        scanExtensions: [".jpg", ".png"], companionExtensions: [".xmp"], maxUploadMB: 512,
        scanSources: [{ id: "file_metadata", enabled: true }, { id: "folder_structure", enabled: true }],
        backSides: { sources: [{ id: "epson", enabled: true }, { id: "named", enabled: false }, { id: "custom", enabled: false }], patterns: [] }
      }
    }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("moves it to another folder after a confirmation naming it", async () => {
    const user = userEvent.setup();
    mount({ ...on, where: "custom" });
    // The folder's row is the way to change it.
    await user.click(await screen.findByRole("button", { name: /Change$/ }));
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
  it("lists the system folder and what goes in it, the locations, and waits on steps 3 and 4", async () => {
    const user = userEvent.setup();
    mount(off, StorageSection);
    const headings = await screen.findAllByRole("heading", { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual(expect.arrayContaining(["System locations", "Library locations", "Containers and applications"]));
    // 1. The folder, then each thing in it: in the system folder unless it has its own.
    expect(await screen.findByText("D:\\iSputnikData")).toBeInTheDocument();
    expect(await screen.findByText("What goes here")).toBeInTheDocument();
    expect(screen.getAllByText("In the system folder").length).toBeGreaterThanOrEqual(3);
    // No library location yet: Containers and applications waits, and personal libraries are not offered.
    expect(screen.getByText("After steps 1 and 2")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set up" })).not.toBeInTheDocument();
    // Manage opens the full System data and App storage panels.
    await user.click(screen.getByRole("button", { name: "Manage" }));
    expect(await screen.findByRole("switch", { name: "App storage" })).toBeInTheDocument();
  });
});

describe("the Storage page's library locations", () => {
  it("names a folder's drive", () => {
    expect(driveOf(String.raw`d:\Demo\media`)).toBe("D:");
    expect(driveOf(String.raw`\\nas\share\photos`)).toBe(String.raw`\\nas\share`);
    expect(driveOf("/mnt/user/media/photos")).toBe("/mnt/user");
  });

  it("groups several locations by drive, greys Remove on a location in use, and asks first", async () => {
    const user = userEvent.setup();
    // The test before left the page on ?show=system.
    window.history.replaceState(null, "", "/control/settings/storage");
    roots = [
      { id: "a", name: "Media", path: String.raw`D:\Media`, libraryCount: 3 },
      { id: "b", name: "Old", path: String.raw`D:\Old`, libraryCount: 0 },
      { id: "c", name: "Photos", path: String.raw`E:\Photos`, libraryCount: 1 }
    ];
    mount(off, StorageSection);
    expect(await screen.findByText("Drive D:")).toBeInTheDocument();
    expect(screen.getByText("Drive E:")).toBeInTheDocument();
    // What goes in them, in a line; personal libraries set apart under them.
    expect(screen.getByText("Digital libraries for audiobooks, ebooks and photos.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set up" })).toBeInTheDocument();
    const removes = screen.getAllByRole("button", { name: "Remove" });
    expect(removes.map((button) => (button as HTMLButtonElement).disabled)).toEqual([true, false, true]);
    await user.click(removes[1]);
    const confirm = await screen.findByRole("dialog", { name: 'Remove "Old"?' });
    await user.click(within(confirm).getByRole("button", { name: "Remove location" }));
    await waitFor(() => expect(posts).toContainEqual({ path: "/api/storage/roots/b", body: null }));
  });
});
