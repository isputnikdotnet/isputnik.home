import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn() }));

const { api } = await import("../src/api");
const { MapSetupSection } = await import("../src/features/control/sections/maps/MapSetupSection");
const mockApi = vi.mocked(api);

// Maps › Setup (docs/map-approach-proposal.md, "Optional, and off by default").
// What must hold: every level says truthfully whether it is on and what it costs;
// nothing that deletes data happens without a confirmation that says how much;
// and the wizard does exactly what was ticked — a level that fails is reported,
// and does not stop the next one.

const MB = 1024 * 1024;

type PlacesState = "off" | "on" | "building" | "failed";

function places(state: PlacesState = "off") {
  return {
    present: state === "on",
    sizeBytes: state === "on" ? 27 * MB : 0,
    builtAt: state === "on" ? "2026-09-12T10:00:00.000Z" : null,
    sourceDate: state === "on" ? "2026-09-12T01:56:16.000Z" : null,
    places: state === "on" ? 235747 : 0,
    build: {
      running: state === "building",
      jobId: state === "off" ? null : "job1",
      stage: state === "building" ? "download" : null,
      done: state === "building" ? 64 * MB : 0,
      total: 0,
      error: state === "failed" ? "GeoNames could not be reached." : null,
      finishedAt: null
    }
  };
}

function status(overrides: { cache?: boolean; bytes?: number; country?: boolean; city?: boolean; places?: PlacesState } = {}) {
  const databases = [
    ...(overrides.city ? [{ file: "D:\\geoip\\owner-city.mmdb", name: "owner-city.mmdb", tier: "city", databaseType: "DBIP-City-Lite", buildDate: "2026-08-01T00:00:00.000Z", sizeBytes: 120 * MB, updatedAt: "2026-08-02T00:00:00.000Z" }] : []),
    ...(overrides.country ? [{ file: "D:\\geoip\\dbip-country-lite.mmdb", name: "dbip-country-lite.mmdb", tier: "country", databaseType: "DBIP-Country-Lite", buildDate: "2026-09-01T00:00:00.000Z", sizeBytes: 9 * MB, updatedAt: "2026-09-02T00:00:00.000Z" }] : [])
  ];
  return {
    settings: { cache: overrides.cache ?? false },
    cache: { folder: "D:\\Demo\\iSputnik\\Map data", path: "D:\\Demo\\iSputnik\\Map data\\Tiles", bytes: overrides.bytes ?? 0 },
    locations: {
      available: databases.length > 0,
      tier: overrides.city ? "city" : overrides.country ? "country" : null,
      databaseType: null, buildDate: null, updatedAt: null, sizeBytes: null,
      directory: "D:\\isputnik\\data\\geoip",
      databases,
      countryFilePresent: Boolean(overrides.country),
      source: "DB-IP"
    },
    places: places(overrides.places)
  };
}

let calls: { path: string; method: string; body?: unknown }[] = [];

function mount(initial: ReturnType<typeof status>, handlers: Record<string, (body: unknown) => unknown> = {}) {
  calls = [];
  let current = initial;
  mockApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (typeof path !== "string") return undefined;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    const handler = handlers[`${method} ${path}`];
    if (handler) {
      const result = handler(body) as { next?: ReturnType<typeof status>; reply?: unknown } | undefined;
      if (result?.next) current = result.next;
      return result?.reply ?? {};
    }
    if (method === "GET" && path === "/api/map/settings") return current;
    throw new Error(`unexpected ${method} ${path}`);
  });
  render(<MapSetupSection />);
}

const row = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;

beforeEach(() => { mockApi.mockReset(); });

describe("Maps › Setup", () => {
  it("shows each level as it really is: off, or on with what it costs", async () => {
    mount(status({ cache: true, bytes: 48 * MB, country: true }));
    await screen.findByText("Maps on this server");
    expect(within(row("Maps on this server")).getByText(/On · 48(\.\d+)? MB kept in D:\\Demo\\iSputnik\\Map data/)).toBeInTheDocument();
    expect(within(row("Sign-in countries")).getByText(/On · 9(\.\d+)? MB/)).toBeInTheDocument();
    expect(within(row("Sign-in towns")).getByText("Off")).toBeInTheDocument();
    // Towns are the owner's own file, so the way in is the Data tab, not the wizard.
    expect(within(row("Sign-in towns")).getByRole("button", { name: "Add a database" })).toBeInTheDocument();
    expect(within(row("Named places")).getByText("Off")).toBeInTheDocument();
    expect(within(row("Named places")).getByRole("button", { name: "Turn on" })).toBeInTheDocument();
  });

  it("follows a places build, and offers no removal while one runs", async () => {
    mount(status({ places: "building" }));
    await screen.findByText("Named places");
    expect(within(row("Named places")).getByText(/Building · downloading from GeoNames, 64(\.\d+)? MB so far/)).toBeInTheDocument();
    expect(within(row("Named places")).queryByRole("button")).toBeNull();
  });

  it("shows a failed build as off, with the reason", async () => {
    mount(status({ places: "failed" }));
    await screen.findByText("Named places");
    expect(within(row("Named places")).getByText("Off · the last build failed: GeoNames could not be reached.")).toBeInTheDocument();
  });

  it("confirms before removing named places, saying what goes with them", async () => {
    const user = userEvent.setup();
    mount(status({ places: "on" }), {
      "DELETE /api/map/places": () => ({ next: status(), reply: { freedBytes: 27 * MB, places: places() } })
    });
    await screen.findByText("Named places");
    expect(within(row("Named places")).getByText(/On · 235.747 places, 27(\.\d+)? MB, built/)).toBeInTheDocument();
    await user.click(within(row("Named places")).getByRole("button", { name: "Remove" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Remove named places?")).toBeInTheDocument();
    expect(within(dialog).getByText(/the Places filter goes/)).toBeInTheDocument();
    expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Remove named places" }));

    await waitFor(() => expect(calls.some((call) => call.method === "DELETE" && call.path === "/api/map/places")).toBe(true));
    expect(await screen.findByText(/27(\.\d+)? MB freed/)).toBeInTheDocument();
    expect(within(row("Named places")).getByText("Off")).toBeInTheDocument();
  });

  it("confirms before turning the cache off, says what that deletes, and reports what it freed", async () => {
    const user = userEvent.setup();
    mount(status({ cache: true, bytes: 48 * MB }), {
      "PUT /api/map/settings": () => ({ next: status({ cache: false }), reply: { settings: { cache: false }, freedBytes: 48 * MB } })
    });
    await user.click(within(await screen.findByText("Maps on this server").then(() => row("Maps on this server"))).getByRole("button", { name: "Turn off" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Turn off maps on this server?")).toBeInTheDocument();
    expect(within(dialog).getByText(/The 48(\.\d+)? MB of kept maps is deleted/)).toBeInTheDocument();
    // Nothing has been sent yet: only the page's own load.
    expect(calls.filter((call) => call.method !== "GET")).toEqual([]);

    await user.click(within(dialog).getByRole("button", { name: "Turn off and delete" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
    expect(calls.find((call) => call.method === "PUT")).toEqual({ path: "/api/map/settings", method: "PUT", body: { cache: false } });
    expect(await screen.findByText(/48(\.\d+)? MB freed/)).toBeInTheDocument();
    expect(within(row("Maps on this server")).getByText("Off · maps come straight from OpenFreeMap")).toBeInTheDocument();
  });

  it("removes the database the row is about, and warns that a supplied one cannot be fetched again", async () => {
    const user = userEvent.setup();
    mount(status({ country: true, city: true }), {
      "DELETE /api/dashboard/locations/database/owner-city.mmdb": () => ({ next: status({ country: true }), reply: { freedBytes: 120 * MB } })
    });
    await screen.findByText("Sign-in towns");
    await user.click(within(row("Sign-in towns")).getByRole("button", { name: "Remove" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText('Remove "owner-city.mmdb"?')).toBeInTheDocument();
    expect(within(dialog).getByText(/the app cannot fetch it again/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Remove database" }));

    await waitFor(() => expect(calls.some((call) => call.method === "DELETE")).toBe(true));
    expect(within(row("Sign-in towns")).getByText("Off")).toBeInTheDocument();
  });
});

describe("the setup wizard", () => {
  it("offers only what is off, runs exactly what was ticked, and keeps going past a failure", async () => {
    const user = userEvent.setup();
    mount(status({}), {
      "PUT /api/map/settings": () => { throw new Error("The map service could not be reached."); },
      "POST /api/map/places": () => ({ next: status({ places: "building" }), reply: { places: places("building") } }),
      "POST /api/dashboard/locations/database": () => ({ next: status({ country: true, places: "building" }), reply: {} })
    });
    await user.click(await screen.findByRole("button", { name: "Set up maps" }));

    // Step 1: every level offered, every one ticked by default.
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Step 1 of 3")).toBeInTheDocument();
    const boxes = within(dialog).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((box) => box.checked)).toEqual([true, true, true]);
    await user.click(within(dialog).getByRole("button", { name: "Next" }));

    // Step 2: where each thing lands.
    expect(within(dialog).getByText("Maps are kept in D:\\Demo\\iSputnik\\Map data.")).toBeInTheDocument();
    expect(within(dialog).getByText("Named places are kept in D:\\Demo\\iSputnik\\Map data.")).toBeInTheDocument();
    expect(within(dialog).getByText("The location database goes in D:\\isputnik\\data\\geoip.")).toBeInTheDocument();
    expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Set up" }));

    // Step 3: the cache failed, and the country database still went ahead.
    expect(await within(dialog).findByText("Not everything was set up")).toBeInTheDocument();
    expect(within(dialog).getByText("Failed: The map service could not be reached.")).toBeInTheDocument();
    expect(within(dialog).getByText("Done")).toBeInTheDocument();
    // Named places only start here: the build runs for minutes, on the Tasks page.
    expect(within(dialog).getByText("Building in the background")).toBeInTheDocument();
    expect(within(dialog).getByText(/You can close this/)).toBeInTheDocument();
    expect(calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path}`)).toEqual([
      "PUT /api/map/settings",
      "POST /api/map/places",
      "POST /api/dashboard/locations/database"
    ]);
  });

  it("does not offer a level that is already on, and will not start with nothing chosen", async () => {
    const user = userEvent.setup();
    // A build under way counts as on: asking again would only join it.
    mount(status({ cache: true, country: true, places: "building" }));
    await user.click(await screen.findByRole("button", { name: "Set up maps" }));
    const dialog = await screen.findByRole("dialog");
    const boxes = within(dialog).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.every((box) => box.disabled)).toBe(true);
    expect(within(dialog).getAllByText("Already on")).toHaveLength(3);
    expect(within(dialog).getByRole("button", { name: "Next" })).toBeDisabled();
  });
});
