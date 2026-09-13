import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn() }));

const { api } = await import("../src/api");
const { MapSetupSection } = await import("../src/features/control/sections/maps/MapSetupSection");
const mockApi = vi.mocked(api);

// The Maps page (docs/map-approach-proposal.md, "A simpler Maps › Setup"): four
// cards with switches. What must hold: each card says truthfully whether it is on
// and what it costs; a switch never downloads or deletes anything without one
// confirmation that says what; and each card's own actions do exactly their job.

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

function status(overrides: { cache?: boolean; bytes?: number; limit?: number; country?: boolean; city?: boolean; places?: PlacesState } = {}) {
  const databases = [
    ...(overrides.city ? [{ file: "D:\\Map data\\Locations\\owner-city.mmdb", name: "owner-city.mmdb", tier: "city", databaseType: "DBIP-City-Lite", buildDate: "2026-08-01T00:00:00.000Z", sizeBytes: 120 * MB, updatedAt: "2026-08-02T00:00:00.000Z" }] : []),
    ...(overrides.country ? [{ file: "D:\\Map data\\Locations\\dbip-country-lite.mmdb", name: "dbip-country-lite.mmdb", tier: "country", databaseType: "DBIP-Country-Lite", buildDate: "2026-09-01T00:00:00.000Z", sizeBytes: 8 * MB, updatedAt: "2026-09-02T00:00:00.000Z" }] : [])
  ];
  return {
    settings: { cache: overrides.cache ?? false, cacheLimitMb: overrides.limit ?? 200 },
    cache: { folder: "D:\\Demo\\Map data", path: "D:\\Demo\\Map data\\Tiles", bytes: overrides.bytes ?? 0, limitBytes: (overrides.limit ?? 200) * MB },
    locations: {
      available: databases.length > 0,
      tier: overrides.city ? "city" : overrides.country ? "country" : null,
      databaseType: null, buildDate: null, updatedAt: null, sizeBytes: null,
      directory: "D:\\Demo\\Map data\\Locations",
      databases,
      countryFilePresent: Boolean(overrides.country),
      source: "DB-IP"
    },
    places: places(overrides.places)
  };
}

let calls: { path: string; method: string; body?: unknown }[] = [];

function mount(
  initial: ReturnType<typeof status>,
  handlers: Record<string, (body: unknown) => unknown> = {},
  routing = { endpoint: "", hasApiKey: false }
) {
  calls = [];
  let current = initial;
  let routes = routing;
  mockApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (typeof path !== "string") return undefined;
    const method = init?.method ?? "GET";
    const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    const handler = handlers[`${method} ${path}`];
    if (handler) {
      const result = handler(body) as { next?: ReturnType<typeof status>; routing?: typeof routing; reply?: unknown } | undefined;
      if (result?.next) current = result.next;
      if (result?.routing) routes = result.routing;
      return result?.reply ?? {};
    }
    if (method === "GET" && path === "/api/map/settings") return current;
    if (method === "GET" && path === "/api/config/routing") return { routing: routes, configured: routes.hasApiKey };
    throw new Error(`unexpected ${method} ${path}`);
  });
  render(<MapSetupSection />);
}

const card = async (title: string) => (await screen.findByRole("heading", { name: new RegExp(`^${title}`) })).closest("section") as HTMLElement;
const actions = () => calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path}`);

beforeEach(() => { mockApi.mockReset(); });

describe("the Maps page", () => {
  it("shows every feature as it is: on or off, and what it costs", async () => {
    mount(status({ cache: true, bytes: 48 * MB, country: true, places: "on" }));
    const offline = await card("Offline maps");
    expect(within(offline).getByRole("switch")).toHaveAttribute("aria-checked", "true");
    expect(within(offline).getByText(/48(\.\d+)? MB of 200 MB/)).toBeInTheDocument();

    const placesCard = await card("Photo place names");
    expect(within(placesCard).getByRole("switch")).toHaveAttribute("aria-checked", "true");
    expect(within(placesCard).getByText(/235.747 places · built/)).toBeInTheDocument();

    const signIns = await card("Sign-in locations");
    expect(within(signIns).getByRole("switch")).toHaveAttribute("aria-checked", "true");
    expect(within(signIns).getByText("Not added")).toBeInTheDocument();

    const routes = await card("Road routes");
    expect(within(routes).getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/All map data is kept in D:\\Demo\\Map data/)).toBeInTheDocument();
  });

  it("asks before turning offline maps on, saying the limit and the folder, then turns them on", async () => {
    const user = userEvent.setup();
    mount(status(), { "PUT /api/map/settings": () => ({ next: status({ cache: true }), reply: { settings: { cache: true, cacheLimitMb: 200 }, freedBytes: 0 } }) });
    await user.click(within(await card("Offline maps")).getByRole("switch"));

    // A turn-on is no danger, so this confirmation is a plain dialog.
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/up to 200 MB, in D:\\Demo\\Map data/)).toBeInTheDocument();
    expect(actions()).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(actions()).toEqual(["PUT /api/map/settings"]));
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ cache: true });
  });

  it("changes the limit at once, and reports what a lower limit freed", async () => {
    const user = userEvent.setup();
    mount(status({ cache: true, bytes: 180 * MB }), {
      "PUT /api/map/settings": () => ({ next: status({ cache: true, bytes: 90 * MB, limit: 100 }), reply: { freedBytes: 90 * MB } })
    });
    await user.selectOptions(within(await card("Offline maps")).getByLabelText("Keep up to"), "100");
    await waitFor(() => expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ cacheLimitMb: 100 }));
    expect(await screen.findByText(/90(\.\d+)? MB freed/)).toBeInTheDocument();
  });

  it("follows a places build, and cannot be switched off while one runs", async () => {
    mount(status({ places: "building" }));
    const placesCard = await card("Photo place names");
    expect(within(placesCard).getByText(/Building · downloading from GeoNames, 64(\.\d+)? MB so far/)).toBeInTheDocument();
    expect(within(placesCard).getByRole("switch")).toBeDisabled();
  });

  it("says why the last places build failed", async () => {
    mount(status({ places: "failed" }));
    expect(within(await card("Photo place names")).getByText("The last build failed: GeoNames could not be reached.")).toBeInTheDocument();
  });

  it("turns sign-in locations off by deleting every database, warning that a supplied one cannot come back", async () => {
    const user = userEvent.setup();
    mount(status({ country: true, city: true }), {
      "DELETE /api/dashboard/locations/database/owner-city.mmdb": () => ({ reply: { freedBytes: 120 * MB } }),
      "DELETE /api/dashboard/locations/database/dbip-country-lite.mmdb": () => ({ next: status(), reply: { freedBytes: 8 * MB } })
    });
    await user.click(within(await card("Sign-in locations")).getByRole("switch"));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/"owner-city.mmdb" came from you, so the app cannot fetch it again/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Turn off and delete" }));
    await waitFor(() => expect(actions()).toEqual([
      "DELETE /api/dashboard/locations/database/owner-city.mmdb",
      "DELETE /api/dashboard/locations/database/dbip-country-lite.mmdb"
    ]));
    expect(await screen.findByText(/128(\.\d+)? MB freed/)).toBeInTheDocument();
  });

  it("points to where a towns database can be downloaded, and takes one from a link", async () => {
    const user = userEvent.setup();
    mount(status({ country: true }), {
      "POST /api/dashboard/locations/database/url": () => ({ next: status({ country: true, city: true }), reply: { installed: { name: "owner-city.mmdb" } } })
    });
    const signIns = await card("Sign-in locations");
    await user.click(within(signIns).getByRole("button", { name: "Where to get a towns database" }));
    expect(screen.getByRole("link", { name: /DB-IP City Lite/ })).toHaveAttribute("href", "https://db-ip.com/db/download/ip-to-city-lite");
    expect(screen.getByRole("link", { name: /MaxMind GeoLite2 City/ })).toHaveAttribute("href", expect.stringContaining("maxmind.com"));

    await user.click(within(signIns).getByRole("button", { name: "Link" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Download link"), "https://example.com/city.mmdb.gz");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(actions()).toEqual(["POST /api/dashboard/locations/database/url"]));
    expect(await screen.findByText("Now using owner-city.mmdb.")).toBeInTheDocument();
  });

  it("turns road routes on by asking for a key, which Test saves and checks in one go", async () => {
    const user = userEvent.setup();
    mount(status(), {
      "PUT /api/config/routing": () => ({ routing: { endpoint: "", hasApiKey: true }, reply: { routing: { endpoint: "", hasApiKey: true }, configured: true } }),
      "POST /api/config/routing/test": () => ({ reply: { ok: true } })
    });
    const routes = await card("Road routes");
    await user.click(within(routes).getByRole("switch"));
    // Nothing is saved by the switch itself: there is no key yet.
    expect(actions()).toEqual([]);
    await user.type(within(routes).getByLabelText("API key"), "my-key");
    await user.click(within(routes).getByRole("button", { name: "Save and test" }));
    await waitFor(() => expect(actions()).toEqual(["PUT /api/config/routing", "POST /api/config/routing/test"]));
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ endpoint: "", apiKey: "my-key" });
    expect(await within(routes).findByText("Works")).toBeInTheDocument();
  });

  it("asks before removing the routing key, saying saved routes keep their roads", async () => {
    const user = userEvent.setup();
    mount(status(), {
      "PUT /api/config/routing": () => ({ routing: { endpoint: "", hasApiKey: false }, reply: {} })
    }, { endpoint: "", hasApiKey: true });
    await user.click(within(await card("Road routes")).getByRole("switch"));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Routes already saved keep their roads/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ endpoint: "", clearApiKey: true }));
  });
});
