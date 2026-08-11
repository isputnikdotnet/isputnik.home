import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "../src/api";

vi.mock("../src/api", () => ({ api: vi.fn() }));

const { api } = await import("../src/api");
const { RecycleBinSection } = await import("../src/features/control/sections/RecycleBinSection");
const mockApi = vi.mocked(api);

// The retention clocks are an install-wide setting, so the way to them must not
// depend on the bin holding something. It used to: the button lived in the toolbar,
// and the toolbar only renders when there is a row to act on — which made the
// setting unreachable in exactly the state an admin is most likely to be tidying in.

const admin = { id: "u1", role: "admin", displayName: "Boss", email: "boss@test.local" } as PublicUser;
const member = { id: "u2", role: "member", displayName: "Kid", email: "kid@test.local" } as PublicUser;

function mount(user: PublicUser, items: unknown[] = []) {
  mockApi.mockImplementation(async () => ({
    items,
    bins: [],
    retentionDays: 30,
    cleanupRetentionDays: null
  }));
  render(<RecycleBinSection currentUser={user} />);
}

const settingsButton = () => screen.queryByRole("button", { name: "Recycle Bin settings" });

beforeEach(() => mockApi.mockReset());

describe("recycle bin settings button", () => {
  it("is reachable when the bin is empty", async () => {
    mount(admin);
    await waitFor(() => expect(screen.getByText("The Recycle Bin is empty.")).toBeInTheDocument());
    expect(settingsButton()).toBeInTheDocument();
  });

  it("sits beside the search box, not in the item toolbar", async () => {
    mount(admin);
    await waitFor(() => expect(settingsButton()).toBeInTheDocument());
    // Same wrapper as the search field, so the two travel together whatever the
    // toolbar below is doing.
    const search = document.querySelector(".trash-search");
    expect(search?.parentElement).toContainElement(settingsButton());
  });

  it("stays hidden from a member, who has no business setting install-wide clocks", async () => {
    mount(member);
    await waitFor(() => expect(screen.getByText("The Recycle Bin is empty.")).toBeInTheDocument());
    expect(settingsButton()).not.toBeInTheDocument();
  });
});
