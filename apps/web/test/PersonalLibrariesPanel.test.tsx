import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn() }));

const { api } = await import("../src/api");
const { PersonalLibrariesPanel } = await import("../src/features/control/sections/storage/PersonalLibrariesPanel");
const mockApi = vi.mocked(api);

// Where personal libraries are made is ONE folder, said as a path; choosing a location
// and a folder name inside it is a dialog that shows the path before saving.

const roots = [
  { id: "media", name: "Demo media", path: String.raw`D:\Demo\media`, libraryCount: 9, createdAt: "", updatedAt: "" },
  { id: "restore", name: "Test", path: String.raw`D:\Restore`, libraryCount: 0, createdAt: "", updatedAt: "" }
];

let puts: unknown[] = [];

function view(settings: Record<string, unknown>) {
  const root = roots.find((r) => r.id === settings.storageRootId);
  return {
    settings: { enabled: true, storageRootId: "media", folder: "Personal", who: "everyone", subjects: [], sizeLimitGB: null, ...settings },
    parentFolder: root ? `${root.path}\\${String(settings.folder ?? "Personal")}` : null,
    libraries: [{ id: "l1", name: "A", ownerId: "u1", ownerName: "Ann", orphanedAt: null, adoptedAt: null, createdAt: "", sizeBytes: 10, phones: 1 }]
  };
}

beforeEach(() => {
  puts = [];
  mockApi.mockReset();
  mockApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      puts.push(body);
      return view(body);
    }
    if (path === "/api/storage/personal-libraries") return view({ storageRootId: "media" });
    if (path === "/api/users") return { users: [] };
    if (path === "/api/groups") return { groups: [] };
    if (path.startsWith("/api/library/gallery-libraries")) return { libraries: [] };
    throw new Error(`unexpected ${path}`);
  });
});

describe("where personal libraries are made", () => {
  it("shows one folder, and changes it in a dialog that previews the path", async () => {
    const user = userEvent.setup();
    render(<PersonalLibrariesPanel storageRoots={roots} />);
    expect(await screen.findByText(String.raw`D:\Demo\media\Personal`)).toBeInTheDocument();
    const row = screen.getByRole("button", { name: /^Personal libraries location/ });
    expect(row).toHaveTextContent('Inside the library location "Demo media"');
    expect(row).toHaveTextContent("Change");
    // No list of every location on the page any more.
    expect(screen.queryByText(String.raw`D:\Restore`)).not.toBeInTheDocument();

    await user.click(row);
    const dialog = await screen.findByRole("dialog", { name: "Where personal libraries are made" });
    await user.selectOptions(within(dialog).getByLabelText("Library location"), "restore");
    const folder = within(dialog).getByLabelText("Folder name");
    await user.clear(folder);
    await user.type(folder, "Members");
    expect(within(dialog).getByText(String.raw`New personal libraries will be made in D:\Restore\Members.`)).toBeInTheDocument();
    expect(within(dialog).getByText("The 1 personal library already made stays where it is.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts).toEqual([expect.objectContaining({ storageRootId: "restore", folder: "Members" })]));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("links only a personal library the admin may manage; someone else's leads nowhere", async () => {
    mockApi.mockImplementation(async (path: string) => {
      if (path === "/api/storage/personal-libraries") {
        return {
          ...view({ storageRootId: "media" }),
          libraries: [
            { id: "mine", name: "Mine", ownerId: "me", ownerName: "Demo Admin", orphanedAt: null, adoptedAt: null, createdAt: "", sizeBytes: 10, phones: 2 },
            { id: "theirs", name: "Theirs", ownerId: "u2", ownerName: "TV Tester", orphanedAt: null, adoptedAt: null, createdAt: "", sizeBytes: 5, phones: 0 }
          ]
        };
      }
      if (path === "/api/users") return { users: [] };
      if (path === "/api/groups") return { groups: [] };
      if (path.startsWith("/api/library/gallery-libraries")) {
        return { libraries: [
          { id: "mine", name: "Mine", role: null, personal: {}, canManageLibrary: true },
          { id: "theirs", name: "Theirs", role: null, personal: {}, canManageLibrary: false }
        ] };
      }
      throw new Error(`unexpected ${path}`);
    });
    render(<PersonalLibrariesPanel storageRoots={roots} />);
    expect(await screen.findByRole("link", { name: /Personal — Demo Admin/ })).toHaveAttribute("href", "/control/libraries/mine");
    expect(await screen.findByText("Personal — TV Tester")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Personal — TV Tester/ })).not.toBeInTheDocument();
  });

  it("makes a library personal on a page of its own: chosen in the page, then confirmed", async () => {
    const user = userEvent.setup();
    const posts: unknown[] = [];
    mockApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") { posts.push({ path, body: JSON.parse(String(init.body)) }); return view({ storageRootId: "media" }); }
      if (path === "/api/storage/personal-libraries") return view({ storageRootId: "media" });
      if (path === "/api/users") return { users: [{ id: "u1", displayName: "Ann" }, { id: "u9", displayName: "Zoe" }] };
      if (path === "/api/groups") return { groups: [] };
      if (path.startsWith("/api/library/gallery-libraries")) return { libraries: [{ id: "g1", name: "Zoe's phone photos", role: null, personal: null }] };
      throw new Error(`unexpected ${path}`);
    });
    render(<PersonalLibrariesPanel storageRoots={roots} part="actions" />);
    // No list of libraries and no settings here — only the choice.
    const make = await screen.findByRole("button", { name: "Make it personal" });
    expect(make).toBeDisabled();
    expect(screen.queryByText("Members may have a personal library")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Library"), "g1");
    await user.selectOptions(screen.getByLabelText("Member"), "u9");
    await user.click(make);
    const confirm = await screen.findByRole("alertdialog", { name: `Make "Zoe's phone photos" Zoe's personal library?` });
    await user.click(within(confirm).getByRole("button", { name: "Make it personal" }));
    await waitFor(() => expect(posts).toEqual([{ path: "/api/storage/personal-libraries/adopt", body: { libraryId: "g1", userId: "u9" } }]));
  });

  it("says who has access in a row, and changes it in a dialog", async () => {
    const user = userEvent.setup();
    render(<PersonalLibrariesPanel storageRoots={roots} />);
    const row = await screen.findByRole("button", { name: /^Access/ });
    expect(row).toHaveTextContent("Every member");
    // The choices are no longer on the page itself.
    expect(screen.queryByText("Only the members and groups chosen")).not.toBeInTheDocument();
    await user.click(row);
    // The standard access window, on/off: Everyone has access, or only those listed.
    const dialog = await screen.findByRole("dialog", { name: "Access to personal libraries" });
    await user.click(within(dialog).getByRole("button", { name: /^Everyone: Has access/ }));
    await user.click(within(dialog).getByRole("option", { name: /No access/ }));
    await waitFor(() => expect(puts).toEqual([expect.objectContaining({ who: "chosen" })]));
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(await screen.findByRole("button", { name: /^Access/ })).toHaveTextContent("No one chosen yet");
  });

  it("adds members and groups from the window's Add tab, and removes them with ×", async () => {
    const user = userEvent.setup();
    let current = view({ storageRootId: "media", who: "chosen", subjects: [{ type: "user", id: "u1" }] });
    mockApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        current = view(body);
        return current;
      }
      if (path === "/api/storage/personal-libraries") return current;
      if (path === "/api/users") return { users: [{ id: "u1", displayName: "Ann" }, { id: "u2", displayName: "Bo" }] };
      if (path === "/api/groups") return { groups: [{ id: "g1", name: "Kids" }] };
      if (path.startsWith("/api/library/gallery-libraries")) return { libraries: [] };
      throw new Error(`unexpected ${path}`);
    });
    render(<PersonalLibrariesPanel storageRoots={roots} />);
    await user.click(await screen.findByRole("button", { name: /^Access/ }));
    const dialog = await screen.findByRole("dialog", { name: "Access to personal libraries" });
    // Access tab: Ann has access; no role menus in an on/off list.
    expect(within(dialog).getByText("Ann")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /^Role for Ann/ })).not.toBeInTheDocument();

    // Add tab: search narrows the list.
    await user.click(within(dialog).getByRole("tab", { name: "Add" }));
    const search = within(dialog).getByRole("searchbox", { name: "Search people or groups" });
    await user.type(search, "ki");
    expect(within(dialog).queryByText("Bo")).not.toBeInTheDocument();
    await user.clear(search);

    // Several ticked are all added — in one save, not each overwriting the last.
    for (const box of within(dialog).getAllByRole("checkbox")) await user.click(box);
    await user.click(within(dialog).getByRole("button", { name: "Add 2" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual(expect.objectContaining({ subjects: [{ type: "user", id: "u1" }, { type: "group", id: "g1" }, { type: "user", id: "u2" }] }));

    // Back on Access: × removes.
    await user.click(await within(dialog).findByRole("button", { name: "Remove Ann" }));
    await waitFor(() => expect(puts.at(-1)).toEqual(expect.objectContaining({ subjects: [{ type: "group", id: "g1" }, { type: "user", id: "u2" }] })));
  });
});
