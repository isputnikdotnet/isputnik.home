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

  it("says who may have one in a row, and changes it in a dialog", async () => {
    const user = userEvent.setup();
    render(<PersonalLibrariesPanel storageRoots={roots} />);
    const row = await screen.findByRole("button", { name: /^Who may have one/ });
    expect(row).toHaveTextContent("Every member");
    // The choices are no longer on the page itself.
    expect(screen.queryByText("Only the members and groups chosen")).not.toBeInTheDocument();
    await user.click(row);
    const dialog = await screen.findByRole("dialog", { name: "Who may have a personal library" });
    await user.click(within(dialog).getByText("Only the members and groups chosen"));
    await waitFor(() => expect(puts).toEqual([expect.objectContaining({ who: "chosen" })]));
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("button", { name: /^Who may have one/ })).toHaveTextContent("No one chosen yet");
  });
});
