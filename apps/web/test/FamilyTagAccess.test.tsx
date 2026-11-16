import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn() }));

const { api } = await import("../src/api");
const { FamilyTagAccessPanel } = await import("../src/features/familytree/FamilyTagAccessModal");
const mockApi = vi.mocked(api);

// Family tree settings › Security: a row per branch; Change opens the standard
// access window for who may edit that branch (Editor / Blocked).

let posts: unknown[] = [];

beforeEach(() => {
  posts = [];
  mockApi.mockReset();
  mockApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") { posts.push({ path, body: JSON.parse(String(init.body)) }); return {}; }
    if (path === "/api/family-tree/tags") return { tags: [{ id: "t1", name: "Posse", reach: 42 }] };
    if (path === "/api/users") return { users: [{ id: "u1", displayName: "Ann", email: "ann@home" }] };
    if (path === "/api/groups") return { groups: [{ id: "g1", name: "Kids" }] };
    if (path === "/api/family-tree/tags/t1/editors") return { editors: [] };
    throw new Error(`unexpected ${path}`);
  });
});

describe("family branch editors", () => {
  it("lists branches and opens the access window for one", async () => {
    const user = userEvent.setup();
    render(<FamilyTagAccessPanel />);
    const row = await screen.findByRole("button", { name: /^Posse/ });
    expect(row).toHaveTextContent("Change");
    await user.click(row);
    const dialog = await screen.findByRole("dialog", { name: "Access to the Posse branch" });
    await user.click(await within(dialog).findByRole("button", { name: /^Role for Ann: No access/ }));
    await user.click(within(dialog).getByRole("option", { name: /^Editor/ }));
    await waitFor(() => expect(posts).toEqual([{ path: "/api/family-tree/tags/t1/editors", body: { subjectType: "user", subjectId: "u1", role: "contributor" } }]));
  });
});
