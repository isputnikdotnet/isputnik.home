import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { controlHref } from "../src/router";
import { SceneSearchSection } from "../src/features/control/sections/SceneSearchSection";

vi.mock("../src/api", () => ({ api: vi.fn() }));
const mockApi = vi.mocked(api);

function fixture() {
  return {
    enabled: false,
    model: "siglip-base-patch16-224-q8/1",
    engine: { available: true, version: "0.2.0" as string | null, reason: null as string | null },
    libraries: [
      { id: "fam", name: "Family", photos: 1200, described: 0, unreadable: 0 },
      { id: "old", name: "Scans", photos: 300, described: 0, unreadable: 0 }
    ],
    scan: null as null | { libraryId: string; status: "pending" | "running"; processed: number; total: number; queued: number }
  };
}
let data = fixture();
let calls: { method: string; path: string; body: unknown }[] = [];

beforeEach(() => {
  window.history.replaceState({}, "", controlHref("sceneSearch"));
  data = fixture();
  calls = [];
  mockApi.mockReset();
  mockApi.mockImplementation(async (path, options) => {
    const method = options?.method ?? "GET";
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    if (method !== "GET") calls.push({ method, path, body });
    if (path === "/api/library/gallery/scene/settings" && method === "GET") return data;
    if (path === "/api/library/gallery/scene/settings" && method === "PATCH") {
      if (body.enabled && !data.engine.available) throw new Error(data.engine.reason ?? "no engine");
      data = { ...data, enabled: body.enabled };
      return data;
    }
    if (path === "/api/library/gallery/scene/scan" && method === "POST") return { jobs: 2, ...data };
    if (path === "/api/library/gallery/scene/data" && method === "DELETE") {
      data = { ...data, libraries: data.libraries.map((library) => ({ ...library, described: 0 })) };
      return { removed: 1500, ...data };
    }
    throw new Error(`Unexpected API call: ${method} ${path}`);
  });
});

describe("Search by content (control panel)", () => {
  it("opens switched off, with the engine ready and every library still to describe", async () => {
    render(<SceneSearchSection />);
    const toggle = await screen.findByRole("switch", { name: /Describe photos for search/ });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("link", { name: /Recognition engine/ })).toHaveTextContent("Ready · 0.2.0");

    const progress = screen.getByRole("region", { name: "Photos described" });
    expect(progress).toHaveTextContent("Described so far: 0 of 1,500.");
    expect(within(progress).getByText("Family").closest(".grouped-row")).toHaveTextContent("0 of 1,200");
    // Nothing to scan or delete while it is off and nothing is stored.
    expect(within(progress).queryByRole("button")).toBeNull();
  });

  it("switches on with one click and then offers a scan", async () => {
    const user = userEvent.setup();
    render(<SceneSearchSection />);
    await user.click(await screen.findByRole("switch", { name: /Describe photos for search/ }));

    await waitFor(() => expect(screen.getByRole("switch", { name: /Describe photos for search/ })).toHaveAttribute("aria-checked", "true"));
    expect(calls).toEqual([{ method: "PATCH", path: "/api/library/gallery/scene/settings", body: { enabled: true } }]);
    expect(screen.getByRole("button", { name: "Describe new photos now" })).toBeEnabled();
  });

  it("says why when there is no engine, and shows the server's refusal", async () => {
    data.engine = { available: false, version: null, reason: "The isputnik.faces container is older than 0.2.0 and cannot describe photos yet: update it." };
    const user = userEvent.setup();
    render(<SceneSearchSection />);
    expect(await screen.findByText("The recognition engine is not available")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Recognition engine/ })).toHaveTextContent("Not available");

    await user.click(screen.getByRole("switch", { name: /Describe photos for search/ }));
    await waitFor(() => expect(screen.getAllByText(/older than 0\.2\.0/)).toHaveLength(2));
    expect(screen.getByRole("switch", { name: /Describe photos for search/ })).toHaveAttribute("aria-checked", "false");
  });

  it("shows a running scan, counts what is done, and holds the scan buttons meanwhile", async () => {
    data.enabled = true;
    data.libraries[0].described = 400;
    data.libraries[1] = { ...data.libraries[1], described: 298, unreadable: 2 };
    data.scan = { libraryId: "fam", status: "running", processed: 400, total: 1200, queued: 0 };
    render(<SceneSearchSection />);

    const progress = await screen.findByRole("region", { name: "Photos described" });
    expect(progress).toHaveTextContent("Described so far: 698 of 1,500.");
    expect(within(progress).getByRole("link", { name: /Scan in progress/ })).toHaveTextContent("400 of 1,200");
    expect(within(progress).getByText("Scans").closest(".grouped-row")).toHaveTextContent("Could not be read: 2");
    expect(within(progress).getByRole("button", { name: "Describe new photos now" })).toBeDisabled();
    expect(within(progress).getByRole("button", { name: "Describe every photo again" })).toBeDisabled();
  });

  it("asks before describing everything again", async () => {
    data.enabled = true;
    data.libraries[0].described = 1200;
    const user = userEvent.setup();
    render(<SceneSearchSection />);
    await user.click(await screen.findByRole("button", { name: "Describe every photo again" }));

    const dialog = screen.getByRole("dialog", { name: "Describe every photo again?" });
    expect(dialog).toHaveTextContent("Every photo (1,500)");
    expect(calls).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Describe again" }));
    await waitFor(() => expect(calls).toEqual([{ method: "POST", path: "/api/library/gallery/scene/scan", body: { force: true } }]));
  });

  it("offers to delete what it stored only once switched off, behind a confirmation", async () => {
    data.libraries[0].described = 1200;
    const user = userEvent.setup();
    render(<SceneSearchSection />);
    await user.click(await screen.findByRole("button", { name: "Delete search data" }));

    const dialog = screen.getByRole("alertdialog", { name: "Delete search data?" });
    expect(dialog).toHaveTextContent("Photos, faces, people and tags are not affected.");
    await user.click(within(dialog).getByRole("button", { name: "Delete search data" }));
    await waitFor(() => expect(calls).toEqual([{ method: "DELETE", path: "/api/library/gallery/scene/data", body: undefined }]));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Delete search data" })).toBeNull());
  });
});
