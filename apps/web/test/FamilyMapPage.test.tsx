import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MapShapes, MapViewCommand } from "../src/shared/map";
import type { FamilyPerson, FamilyTree } from "../src/features/familytree/types";
import type { FamilyMapEntry } from "../src/features/familytree/FamilyMapPage";
import { renderSignedIn } from "./helpers/session";

// The family map groups pinned entries by spot, lists the places beside the map,
// and narrows by kind, by name and (from a profile) to one person. Stubbed at the
// renderer seam, like GalleryMap's test: what matters is what the map was asked
// to draw and frame, not any map library.

const drawn: { shapes: MapShapes; views: MapViewCommand[] } = { shapes: {}, views: [] };

vi.mock("../src/shared/map/renderer", () => ({
  createRenderer: () => ({
    mount: vi.fn(),
    setShapes: (shapes: MapShapes) => { drawn.shapes = shapes; },
    applyView: (view: MapViewCommand) => { drawn.views.push(view); },
    addAttribution: vi.fn(),
    destroy: vi.fn()
  })
}));
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
  return {
    ...actual,
    navigate: (path: string) => navigate(path),
    followRoute: (event: React.MouseEvent, path: string) => { event.preventDefault(); navigate(path); }
  };
});

const { api } = await import("../src/api");
const { FamilyMapPage } = await import("../src/features/familytree/FamilyMapPage");
const mockApi = vi.mocked(api);

const person = (id: string, name: string): FamilyPerson => ({
  id, name, maidenName: null, otherNames: [], gender: "unknown", birthDate: null, deathDate: null,
  birthplace: null, deathPlace: null, birthPin: null, deathPin: null, bio: null,
  portraitUrl: null, portraitItemId: null, galleryPersonId: null, tags: [], canEdit: false
});

const entry = (over: Partial<FamilyMapEntry> & Pick<FamilyMapEntry, "id" | "kind" | "personIds" | "place">): FamilyMapEntry => ({
  lat: 53.9, lng: 27.56, date: null, endDate: null, eventType: null, label: null, ...over
});

const MINSK = { lat: 53.9, lng: 27.56 };
const KYIV = { lat: 50.45, lng: 30.52 };

const ENTRIES: FamilyMapEntry[] = [
  entry({ id: "birth:anna", kind: "birth", personIds: ["anna"], place: "Minsk", date: "1920", ...MINSK }),
  entry({ id: "birth:boris", kind: "birth", personIds: ["boris"], place: "Kyiv", date: "1918", ...KYIV }),
  entry({ id: "marriage:u1", kind: "marriage", personIds: ["anna", "boris"], place: "Minsk, Belarus", date: "1945", ...MINSK }),
  entry({ id: "event:e1", kind: "event", personIds: ["anna"], place: "Kyiv", date: "1950", endDate: "1960", eventType: "residence", ...KYIV })
];

function mount(personId: string | null = null, entries = ENTRIES, unpinned = 3) {
  mockApi.mockImplementation(async (path: string) => {
    if (path === "/api/family-tree/tree") {
      return { persons: [person("anna", "Anna Petrova"), person("boris", "Boris Petrov")], unions: [], children: [], access: { isAdmin: false, canAdd: false }, defaultPersonId: null } satisfies FamilyTree as never;
    }
    if (path === "/api/family-tree/map") return { entries, unpinned } as never;
    throw new Error(`unexpected ${path}`);
  });
  return renderSignedIn(<FamilyMapPage personId={personId} />);
}

const placeList = () => within(screen.getByRole("list", { name: "Places" }));

beforeEach(() => {
  mockApi.mockReset();
  navigate.mockReset();
  drawn.shapes = {};
  drawn.views = [];
});

describe("FamilyMapPage", () => {
  it("draws one pin per spot, counts what happened there, and frames them all", async () => {
    mount();
    await screen.findByRole("list", { name: "Places" });
    expect(placeList().getAllByRole("button").map((button) => button.textContent)).toEqual(["Kyiv2", "Minsk2"]);
    // The map draws in an effect after the list renders; under a loaded test run
    // the list can be found first.
    await waitFor(() => expect(drawn.shapes.markers?.map((marker) => [marker.tooltip, marker.html?.includes(">2<")])).toEqual([
      ["Kyiv", true], ["Minsk", true]
    ]));
    // Kyiv holds a birth and a life event, so its pin is the mixed colour.
    expect(drawn.shapes.markers?.[0].html).toContain("is-mixed");
    await waitFor(() => expect(drawn.views.at(-1)).toMatchObject({ kind: "fit", animate: false }));
    expect(screen.getByText(/3 places are written without a pin/)).toBeInTheDocument();
  });

  it("lists what happened at a place, oldest first, with people linked", async () => {
    mount();
    await userEvent.click(await screen.findByRole("button", { name: /^Minsk/ }));
    const panel = screen.getByRole("heading", { name: "Minsk" }).closest("aside") as HTMLElement;
    const rows = within(panel).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual(["Born", "Married"]);
    expect(within(rows[1]).getAllByRole("link").map((link) => link.textContent)).toEqual(["AAnna Petrova", "BBoris Petrov"]);
    // A different spelling of the same spot says how it was written.
    expect(within(rows[1]).getByText("Minsk, Belarus")).toBeInTheDocument();
    expect(drawn.views.at(-1)).toMatchObject({ kind: "fly", points: [[53.9, 27.56]] });
  });

  it("narrows by kind and by name", async () => {
    mount();
    await screen.findByRole("list", { name: "Places" });
    await userEvent.click(screen.getByRole("button", { name: /Births/ }));
    await userEvent.click(screen.getByRole("button", { name: /Life events/ }));
    // Only the marriage is left there, so the spot goes by the words it was written with.
    expect(placeList().getAllByRole("button").map((button) => button.textContent)).toEqual(["Minsk, Belarus1"]);

    await userEvent.click(screen.getByRole("button", { name: /Births/ }));
    await userEvent.type(screen.getByPlaceholderText("Search family members..."), "boris");
    await waitFor(() => expect(placeList().getAllByRole("button").map((button) => button.textContent)).toEqual(["Kyiv1", "Minsk, Belarus1"]));
  });

  it("shows one person's places joined in order, and clears back to everyone", async () => {
    mount("boris");
    await userEvent.click(await screen.findByRole("button", { name: "Show everyone, not only Boris Petrov" }));
    expect(navigate).toHaveBeenCalledWith("/family/map");
    expect(placeList().getAllByRole("button").map((button) => button.textContent)).toEqual(["Kyiv1", "Minsk, Belarus1"]);
    expect(drawn.shapes.lines?.[0].points).toEqual([[50.45, 30.52], [53.9, 27.56]]);
  });

  it("explains an empty map", async () => {
    mount(null, [], 5);
    expect(await screen.findByText("Nothing on the map yet")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Places" })).not.toBeInTheDocument();
  });
});
