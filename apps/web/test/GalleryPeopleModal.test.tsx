import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn() }));

const { api } = await import("../src/api");
const { GalleryPeopleModal } = await import("../src/features/gallery/GalleryPeopleModal");

// The multi-select bar's People dialog: the library's people to pick from (or a
// new name), one bulk request per batch of ids, and the counts handed back so the
// page can say what happened.

const people = [
  { id: "anna", name: "Anna", faceCount: 12, coverUrl: null },
  { id: "boris", name: "Boris", faceCount: 3, coverUrl: null }
];

beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/library/gallery/people") return { people };
    if (path === "/api/library/gallery/assets/bulk-people" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { ids: string[] };
      return { updated: body.ids.length, forbidden: 0, person: { id: "anna", name: "Anna" } };
    }
    throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
  });
});

describe("GalleryPeopleModal", () => {
  it("tags the selection with the picked person and reports the counts", async () => {
    const user = userEvent.setup();
    const onApplied = vi.fn();
    const onClose = vi.fn();
    render(<GalleryPeopleModal itemIds={["p1", "p2", "p3"]} onClose={onClose} onApplied={onApplied} />);

    expect(screen.getByText("Applies to 3 selected items. Pick who is in them; anyone already there stays.")).toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: /Anna/ }));

    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(3, 0, "Anna"));
    const call = vi.mocked(api).mock.calls.find(([path]) => path === "/api/library/gallery/assets/bulk-people")!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ ids: ["p1", "p2", "p3"], personId: "anna" });
    expect(onClose).toHaveBeenCalled();
  });

  it("sends a typed name instead, so the server can create the person once", async () => {
    const user = userEvent.setup();
    const onApplied = vi.fn();
    render(<GalleryPeopleModal itemIds={["p1"]} onClose={() => {}} onApplied={onApplied} />);
    await screen.findByRole("option", { name: /Anna/ });

    await user.type(screen.getByRole("combobox"), "Grandma");
    await user.click(screen.getByRole("option", { name: /Grandma/ }));

    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(1, 0, "Grandma"));
    const call = vi.mocked(api).mock.calls.find(([path]) => path === "/api/library/gallery/assets/bulk-people")!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ ids: ["p1"], name: "Grandma" });
  });

  it("shows the failure and stays open", async () => {
    const user = userEvent.setup();
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/library/gallery/people") return { people };
      throw new Error("Server went away");
    });
    const onApplied = vi.fn();
    render(<GalleryPeopleModal itemIds={["p1"]} onClose={() => {}} onApplied={onApplied} />);
    await user.click(await screen.findByRole("option", { name: /Boris/ }));

    expect(await screen.findByText("Server went away")).toBeInTheDocument();
    expect(onApplied).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
