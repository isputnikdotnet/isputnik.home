import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn() }));

const { api } = await import("../src/api");
const { PersonSharingModal } = await import("../src/features/gallery/PersonSharingModal");
const mockApi = vi.mocked(api);

// Gallery › "Access to photos of Ivan": the standard access window, on/off — a switch
// per member or group; who sees him another way says so on their row.

let calls: { path: string; method?: string }[] = [];

beforeEach(() => {
  calls = [];
  mockApi.mockReset();
  mockApi.mockImplementation(async (path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method });
    if (path === "/api/library/gallery/people/p1/sharing") {
      return {
        subjects: [{ subjectType: "user", subjectId: "u1", name: "Ann" }],
        counts: { shared: 12, excluded: 0, toReview: 0 },
        self: { userId: "u3", name: "Ivan", showPhotos: true },
        viaBranches: [{ subjectType: "group", subjectId: "g1", name: "Kids", branchId: "b1", branchName: "Posse" }]
      };
    }
    if (path === "/api/groups") return { groups: [{ id: "g1", name: "Kids" }, { id: "grp-everyone", name: "Everyone" }] };
    if (path === "/api/users") return { users: [{ id: "u1", displayName: "Ann", role: "member" }, { id: "u2", displayName: "Bo", role: "member" }, { id: "u3", displayName: "Ivan", role: "member" }, { id: "a1", displayName: "Admin", role: "admin" }] };
    if (path.startsWith("/api/library/gallery/people/p1/sharing/")) return {};
    throw new Error(`unexpected ${path}`);
  });
});

describe("access to photos of a person", () => {
  it("is the standard window: Add and Remove, and the other ways said on the row", async () => {
    const user = userEvent.setup();
    render(<PersonSharingModal person={{ id: "p1", name: "Ivan" }} onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog", { name: "Access to photos of Ivan" });
    // On/off: those with access are listed with Remove; Bo is not among them.
    expect(await within(dialog).findByRole("button", { name: "Remove Ann" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Remove Bo" })).not.toBeInTheDocument();
    // Admins see everything already, and the built-in groups are not choices.
    expect(within(dialog).queryByText("Admin")).not.toBeInTheDocument();
    // Ivan's own account, and Kids through a branch, say so on their rows.
    expect(within(dialog).getByText(/Posse/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("combobox", { name: "Add people or groups" }));
    await user.click(within(dialog).getByRole("option", { name: /^Bo/ }));
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(calls).toContainEqual({ path: "/api/library/gallery/people/p1/sharing/user/u2", method: "PUT" }));
    await user.click(within(dialog).getByRole("button", { name: "Remove Ann" }));
    await waitFor(() => expect(calls).toContainEqual({ path: "/api/library/gallery/people/p1/sharing/user/u1", method: "DELETE" }));
  });
});
