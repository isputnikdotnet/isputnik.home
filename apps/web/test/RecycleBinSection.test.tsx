import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  mockApi.mockImplementation(async (path: string) => {
    // The admin page also asks for the bin's deleted stories; an empty answer
    // keeps that panel out of these tests' way.
    if (path === "/api/stories/trash") return { stories: [] };
    return {
      items,
      bins: [],
      retentionDays: 30,
      cleanupRetentionDays: null
    };
  });
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

// Emptying the bin is the only action in the app that destroys many files at once with
// nothing left to restore from. These guard the two ways it used to overreach: taking
// libraries the page wasn't showing, and going through on a single mis-click.
describe("emptying the bin", () => {
  const item = (id: string, libraryId: string, libraryName: string, purgesAt: string | null) => ({
    id,
    libraryId,
    libraryName,
    libraryType: "gallery",
    title: `Item ${id}`,
    path: `/src/${id}`,
    fileCount: 2,
    sizeBytes: 1024,
    coverUrl: null,
    trashedAt: "2026-08-20T10:00:00.000Z",
    trashedByName: "Boss",
    source: "manual",
    purgesAt
  });

  const future = "2099-01-01T00:00:00.000Z";
  const openEmpty = async (name = "Empty Recycle Bin") => {
    await waitFor(() => expect(screen.getByRole("button", { name })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name }));
  };
  // The toolbar's icon button and the dialog's confirm button share a name — both are
  // "Empty Recycle Bin", as they should be — so queries for the confirm are scoped to
  // the dialog rather than made unique by wording the button oddly.
  const dialog = () => within(screen.getByRole("alertdialog"));
  const emptyCall = () =>
    mockApi.mock.calls.find(([path]) => path === "/api/library/trash/empty");

  it("will not go through until the item count is typed back", async () => {
    mount(admin, [item("a", "L1", "Photos", future), item("b", "L1", "Photos", future), item("c", "L2", "Books", future)]);
    await openEmpty();

    const confirm = dialog().getByRole("button", { name: "Empty Recycle Bin" });
    expect(confirm).toBeDisabled();

    // The number is one the dialog itself states, so typing it means having read it.
    await userEvent.type(screen.getByLabelText(/Type 3 to confirm/), "3");
    expect(confirm).toBeEnabled();

    await userEvent.click(confirm);
    await waitFor(() => expect(emptyCall()).toBeTruthy());
    expect(emptyCall()![1]).toMatchObject({ method: "POST", body: "{}" });
  });

  it("refuses a wrong count rather than rounding to what it can find", async () => {
    mount(admin, [item("a", "L1", "Photos", future), item("b", "L1", "Photos", future)]);
    await openEmpty();

    await userEvent.type(screen.getByLabelText(/Type 2 to confirm/), "3");
    expect(dialog().getByRole("button", { name: "Empty Recycle Bin" })).toBeDisabled();
    expect(emptyCall()).toBeUndefined();
  });

  // The bug this is here for: the page filtered to one library, Empty pressed, and
  // every other library's deleted files went with it.
  it("empties only the chosen library, and says so instead of asking for a count", async () => {
    mount(admin, [item("a", "L1", "Photos", future), item("b", "L2", "Books", future)]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Which library's deleted items to show" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Which library's deleted items to show" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Photos" }));

    await openEmpty("Empty Recycle Bin for Photos");
    expect(screen.getByText("Empty the Recycle Bin for “Photos”?")).toBeInTheDocument();
    // Bounded by a library you deliberately picked — no typed challenge here.
    expect(screen.queryByLabelText(/to confirm/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Empty this library" }));
    await waitFor(() => expect(emptyCall()).toBeTruthy());
    expect(JSON.parse(emptyCall()![1]!.body as string)).toEqual({ libraryId: "L1" });
  });

  // The search box narrows the tiles but not the action — the server empties the whole
  // library scope. The dialog must count what it takes, not what is on screen.
  it("counts what it will actually take, not what the search has narrowed to", async () => {
    mount(admin, [item("a", "L1", "Photos", future), item("b", "L1", "Photos", future), item("c", "L1", "Photos", future)]);
    await waitFor(() => expect(screen.getByPlaceholderText(/Search/i)).toBeInTheDocument());
    await userEvent.type(screen.getByPlaceholderText(/Search/i), "Item a");

    await openEmpty();
    expect(screen.getByLabelText(/Type 3 to confirm/)).toBeInTheDocument();
  });

  it("names how many were still owed time, which is what the mistake costs", async () => {
    mount(admin, [
      item("a", "L1", "Photos", future),
      item("b", "L1", "Photos", "2020-01-01T00:00:00.000Z") // already past its date
    ]);
    await openEmpty();
    expect(screen.getByText(/still inside the retention window/)).toBeInTheDocument();
  });

  it("offers no Empty button at all when the bin holds nothing", async () => {
    mount(admin);
    await waitFor(() => expect(screen.getByText("The Recycle Bin is empty.")).toBeInTheDocument());
    // The whole toolbar sits out an empty bin, so there is nothing to press. The
    // button also disables itself on an empty scope, which is the belt to this braces.
    expect(screen.queryByRole("button", { name: /^Empty Recycle Bin/ })).not.toBeInTheDocument();
  });
});
