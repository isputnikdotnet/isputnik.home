import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn() }));

const { api } = await import("../src/api");
const { GalleryPlaceSearch } = await import("../src/features/gallery/GalleryPlaceSearch");
const { distanceKm, recentPlaceName, savedPlaceAt } = await import("../src/features/gallery/savedPlaces");
const mockApi = vi.mocked(api);

// Saved places in the location editor: the household's named points as one-click
// chips under the search box, this person's recent pins after them, and "Save
// this place" for a pin that is not on the list yet.

const HOME = { id: "h", name: "", lat: 53.90123, lng: 27.55912, home: true, useCount: 4 };
const DACHA = { id: "d", name: "Dacha", lat: 53.95, lng: 27.31, home: false, useCount: 2 };
const RECENT = { lat: 45.4642, lng: 9.19, label: "Piazza del Duomo, Centro Storico, Milan, Lombardy, Italy", place: null };

let list: { canSave: boolean; places: typeof HOME[]; recent: typeof RECENT[] };
let calls: { path: string; method: string; body: unknown }[];

beforeEach(() => {
  list = { canSave: true, places: [HOME, DACHA], recent: [RECENT] };
  calls = [];
  mockApi.mockReset();
  mockApi.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path === "/api/library/gallery/saved-places" && method === "GET") return list as never;
    if (path === "/api/library/gallery/saved-places" && method === "POST") {
      const body = JSON.parse(String(init!.body)) as { name: string; lat: number; lng: number };
      const place = { id: "new", home: false, useCount: 0, ...body };
      list = { ...list, places: [...list.places, place] };
      return { place } as never;
    }
    if (method === "DELETE") {
      list = { ...list, places: list.places.filter((place) => !path.endsWith(`/${place.id}`)) };
      return { deleted: true } as never;
    }
    if (path.startsWith("/api/library/gallery/place-suggest")) {
      return { available: true, results: [{ label: "Dachau, Bavaria, Germany", lat: 48.26, lng: 11.43 }] } as never;
    }
    return {} as never;
  });
});

describe("the helpers", () => {
  it("treat a pin across the yard as the saved place, and one down the road as not", () => {
    expect(savedPlaceAt([HOME, DACHA], { lat: 53.9014, lng: 27.55912 })?.id).toBe("h");
    expect(savedPlaceAt([HOME, DACHA], { lat: 53.91, lng: 27.55912 })).toBeNull();
    expect(distanceKm(HOME, DACHA)).toBeGreaterThan(15);
  });

  it("name a recent place by its label, else its town, else its coordinates", () => {
    expect(recentPlaceName(RECENT).short).toBe("Piazza del Duomo, Italy");
    expect(recentPlaceName({ lat: 1, lng: 2, label: null, place: { place: "Verona", region: "Veneto", country: "Italy", countryCode: "IT" } }))
      .toEqual({ short: "Verona, Italy", full: "Verona, Veneto, Italy" });
    expect(recentPlaceName({ lat: 1.23456, lng: 2, label: null, place: null }).short).toBe("1.2346, 2.0000");
  });
});

describe("saved places in the location editor", () => {
  it("offers the saved places, then the recent ones, and picks one in a click", async () => {
    const onPick = vi.fn();
    render(<GalleryPlaceSearch onPick={onPick} saved={{ pin: null, pinLabel: "" }} />);

    const chips = await screen.findByRole("group", { name: "Saved and recent places" });
    expect(within(chips).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["Home", "Dacha", "Piazza del Duomo, Italy"]);
    // Nothing to save while there is no pin.
    expect(screen.queryByRole("button", { name: /Save this place/ })).toBeNull();

    await userEvent.setup().click(within(chips).getByRole("button", { name: "Dacha" }));
    expect(onPick).toHaveBeenCalledWith({ lat: DACHA.lat, lng: DACHA.lng }, "Dacha", 16);
  });

  it("marks the chip the pin stands on, and does not offer to save it again", async () => {
    render(<GalleryPlaceSearch onPick={() => {}} saved={{ pin: { lat: 53.9014, lng: 27.55912 }, pinLabel: "" }} />);
    expect(await screen.findByRole("button", { name: "Home" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Dacha" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("button", { name: /Save this place/ })).toBeNull();
  });

  it("puts a saved place that matches what is typed ahead of the towns", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(<GalleryPlaceSearch onPick={onPick} saved={{ pin: null, pinLabel: "" }} />);
    await screen.findByRole("button", { name: "Dacha" });

    await user.type(screen.getByRole("searchbox"), "dach");
    const results = await screen.findByRole("list");
    await waitFor(() => expect(within(results).getAllByRole("button").map((hit) => hit.textContent)).toEqual(["Dacha", "Dachau, Bavaria, Germany"]));

    await user.click(within(results).getByRole("button", { name: "Dacha" }));
    expect(onPick).toHaveBeenCalledWith({ lat: DACHA.lat, lng: DACHA.lng }, "Dacha", 16);
    expect(screen.getByRole("searchbox")).toHaveValue("");
  });

  it("saves the pin under a name, suggested from what the search called it", async () => {
    const user = userEvent.setup();
    render(<GalleryPlaceSearch onPick={() => {}} saved={{ pin: { lat: 53.7, lng: 27.9 }, pinLabel: "Lake house, Smolevichi District, Belarus" }} />);

    await user.click(await screen.findByRole("button", { name: /Save this place/ }));
    const dialog = screen.getByRole("dialog", { name: "Save this place" });
    const name = within(dialog).getByLabelText("Name");
    expect(name).toHaveValue("Lake house");

    await user.clear(name);
    await user.type(name, "The lake{Enter}");
    await waitFor(() => expect(calls).toEqual([
      { path: "/api/library/gallery/saved-places", method: "POST", body: { name: "The lake", lat: 53.7, lng: 27.9 } }
    ]));
    // The dialog closes and the new place is a chip, marked: the pin stands on it.
    expect(await screen.findByRole("button", { name: "The lake" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says why a place could not be saved, and keeps the dialog open", async () => {
    mockApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") throw new Error("There is already a saved place called \"Dacha\".");
      return (path === "/api/library/gallery/saved-places" ? list : {}) as never;
    });
    const user = userEvent.setup();
    render(<GalleryPlaceSearch onPick={() => {}} saved={{ pin: { lat: 53.7, lng: 27.9 }, pinLabel: "Dacha" }} />);
    await user.click(await screen.findByRole("button", { name: /Save this place/ }));
    await user.click(screen.getByRole("button", { name: "Save place" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("There is already a saved place called \"Dacha\".");
    expect(screen.getByRole("dialog", { name: "Save this place" })).toBeInTheDocument();
  });

  it("deletes a place from Manage places, after asking", async () => {
    const user = userEvent.setup();
    render(<GalleryPlaceSearch onPick={() => {}} saved={{ pin: null, pinLabel: "" }} />);
    await user.click(await screen.findByRole("button", { name: "Manage places" }));

    const manage = screen.getByRole("dialog", { name: "Saved places" });
    await user.click(within(manage).getByRole("button", { name: "Delete “Dacha”" }));
    const confirm = screen.getByRole("alertdialog", { name: "Delete “Dacha”?" });
    expect(confirm).toHaveTextContent("Photos already pinned there keep their place on the map.");
    await user.click(within(confirm).getByRole("button", { name: "Delete place" }));

    await waitFor(() => expect(calls).toEqual([{ path: "/api/library/gallery/saved-places/d", method: "DELETE", body: null }]));
    await waitFor(() => expect(within(manage).queryByText("Dacha")).toBeNull());
    expect(within(manage).getByText("Home")).toBeInTheDocument();
  });

  it("offers nothing to someone who cannot edit photos, and nothing where it is not asked for", async () => {
    list = { canSave: false, places: [], recent: [] };
    const { unmount } = render(<GalleryPlaceSearch onPick={() => {}} saved={{ pin: { lat: 1, lng: 1 }, pinLabel: "" }} />);
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/api/library/gallery/saved-places"));
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.queryByRole("button", { name: /Save this place/ })).toBeNull();
    unmount();

    // The story map uses the same search box without saved places.
    mockApi.mockClear();
    render(<GalleryPlaceSearch onPick={() => {}} />);
    expect(mockApi).not.toHaveBeenCalled();
  });
});
