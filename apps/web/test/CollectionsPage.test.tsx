import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionSummary } from "../src/features/collections/types";
import { renderSignedIn } from "./helpers/session";

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("../src/app/DashboardShell", () => ({
  DashboardShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}));
const navigate = vi.fn();
vi.mock("../src/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/router")>();
  return { ...actual, navigate: (path: string) => navigate(path) };
});

const { api } = await import("../src/api");
const { CollectionsPage } = await import("../src/features/collections/CollectionsPage");
const mockApi = vi.mocked(api);

const collection = (id: string, name: string, over: Partial<CollectionSummary> = {}): CollectionSummary => ({
  id,
  name,
  description: null,
  itemCount: 0,
  coverUrls: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...over
});

type Call = { path: string; method: string; body: unknown };

function mount(collections: CollectionSummary[] | Error, onCreate?: (body: unknown) => unknown) {
  const calls: Call[] = [];
  mockApi.mockImplementation(async (path: string, options?: RequestInit) => {
    const method = options?.method ?? "GET";
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({ path, method, body });
    if (path === "/api/collections" && method === "GET") {
      if (collections instanceof Error) throw collections;
      return { collections } as never;
    }
    if (path === "/api/collections" && method === "POST") return (onCreate?.(body) ?? { collection: collection("new-id", "x") }) as never;
    throw new Error(`unexpected ${method} ${path}`);
  });
  renderSignedIn(<CollectionsPage />);
  return calls;
}

const card = (name: string) => screen.getByRole("button", { name: new RegExp(name) });

beforeEach(() => {
  mockApi.mockReset();
  navigate.mockReset();
});

describe("CollectionsPage", () => {
  it("lists the caller's collections with their item counts and descriptions", async () => {
    mount([
      collection("c1", "Road trip", { itemCount: 3, description: "For the long drive" }),
      collection("c2", "Bedtime", { itemCount: 1 })
    ]);
    expect(await screen.findByText("Road trip")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Collections" })).toBeInTheDocument();
    expect(card("Road trip")).toHaveTextContent("3 items");
    expect(card("Road trip")).toHaveTextContent("For the long drive");
    expect(card("Bedtime")).toHaveTextContent("1 item");
  });

  it("builds each card's mosaic from at most four covers", async () => {
    mount([collection("c1", "Photos", { itemCount: 6, coverUrls: ["/a", "/b", "/c", "/d", "/e", "/f"] })]);
    await screen.findByText("Photos");
    const imgs = card("Photos").querySelectorAll("img");
    expect([...imgs].map((img) => img.getAttribute("src"))).toEqual(["/a", "/b", "/c", "/d"]);
  });

  it("opens a collection when its card is clicked", async () => {
    const user = userEvent.setup();
    mount([collection("c42", "Road trip")]);
    await user.click(await screen.findByText("Road trip"));
    expect(navigate).toHaveBeenCalledWith("/collections/c42");
  });

  it("shows a loading line, then an empty state when there are none", async () => {
    let release!: (value: unknown) => void;
    mockApi.mockImplementation(() => new Promise((resolve) => { release = resolve; }) as never);
    renderSignedIn(<CollectionsPage />);
    expect(screen.getByText("Loading collections…")).toBeInTheDocument();

    release({ collections: [] });
    expect(await screen.findByRole("heading", { name: "No collections yet" })).toBeInTheDocument();
    expect(screen.queryByText("Loading collections…")).not.toBeInTheDocument();
  });

  it("reports a failed load", async () => {
    mount(new Error("Collections are unavailable"));
    expect(await screen.findByText("Collections are unavailable")).toBeInTheDocument();
    expect(screen.getByText("Collections error")).toBeInTheDocument();
  });
});

describe("CollectionsPage — creating", () => {
  it("creates a collection from the dialog and goes straight to it", async () => {
    const user = userEvent.setup();
    const calls = mount([], () => ({ collection: collection("fresh", "Summer") }));
    await screen.findByRole("heading", { name: "No collections yet" });

    await user.click(screen.getByRole("button", { name: "New collection" }));
    const dialog = screen.getByRole("dialog", { name: "New collection" });
    const create = within(dialog).getByRole("button", { name: "Create collection" });
    // Nothing to create until it has a name.
    expect(create).toBeDisabled();

    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "  Summer  ");
    expect(create).toBeEnabled();
    await user.click(create);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/collections/fresh"));
    // Trimmed, and a blank description is sent as null rather than "".
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "Summer", description: null });
  });

  it("sends the description when one is given, trimmed", async () => {
    const user = userEvent.setup();
    const calls = mount([]);
    await screen.findByRole("heading", { name: "No collections yet" });
    await user.click(screen.getByRole("button", { name: "New collection" }));
    const dialog = screen.getByRole("dialog", { name: "New collection" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Car");
    await user.type(within(dialog).getByRole("textbox", { name: /Description/ }), " Long drives ");
    await user.click(within(dialog).getByRole("button", { name: "Create collection" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "Car", description: "Long drives" });
  });

  it("keeps the dialog open with the error when creating fails", async () => {
    const user = userEvent.setup();
    mount([], () => { throw new Error("Name already used"); });
    await screen.findByRole("heading", { name: "No collections yet" });
    await user.click(screen.getByRole("button", { name: "New collection" }));
    const dialog = screen.getByRole("dialog", { name: "New collection" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Dupe");
    await user.click(within(dialog).getByRole("button", { name: "Create collection" }));

    expect(await within(dialog).findByText("Name already used")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    // Ready for another go, not stuck on "Creating…".
    expect(within(dialog).getByRole("button", { name: "Create collection" })).toBeEnabled();
  });

  it("closes the dialog on Cancel without creating anything", async () => {
    const user = userEvent.setup();
    const calls = mount([]);
    await screen.findByRole("heading", { name: "No collections yet" });
    await user.click(screen.getByRole("button", { name: "New collection" }));
    await user.click(within(screen.getByRole("dialog", { name: "New collection" })).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "New collection" })).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});
