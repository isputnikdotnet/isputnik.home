import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn() }));

const { api } = await import("../src/api");
const { DeviceSyncStats } = await import("../src/features/control/sections/DeviceSyncStats");
const mockApi = vi.mocked(api);

// Device Sync › Statistics: who backs up, from what, into how much — from what
// Device Sync already keeps; never what a phone sent. Both tables page.

const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const phone = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `p${n}`, label: `Phone ${n}`, lastSeen: days(1), network: "Tablet Wi-Fi", member: { id: "u1", name: "Ann" }, stale: false, problem: null, ...extra
});
let logQuery = "";

beforeEach(() => {
  mockApi.mockReset();
  mockApi.mockImplementation(async (path: string) => {
    if (path === "/api/storage/personal-libraries") {
      return {
        settings: { enabled: true, sizeLimitGB: 2 },
        libraries: [
          { id: "l1", ownerId: "u1", ownerName: "Ann", orphanedAt: null, sizeBytes: 0.5 * 1024 ** 3, phones: 2 },
          { id: "l2", ownerId: "u2", ownerName: "Bo", orphanedAt: null, sizeBytes: 957, phones: 0 }
        ]
      };
    }
    if (path === "/api/users") return { users: [{ id: "u1", displayName: "Ann" }, { id: "u2", displayName: "Bo" }, { id: "u3", displayName: "Cy" }] };
    if (path.startsWith("/api/logs?")) { logQuery = path; return { total: 3 }; }
    throw new Error(`unexpected ${path}`);
  });
});

describe("Device Sync statistics", () => {
  it("sums up phones, members and the libraries against their limit", async () => {
    const phones = [phone(1, { lastSeen: days(10), stale: true }), phone(2)];
    render(<DeviceSyncStats phones={phones} phoneName={(entry) => entry.label} onOpenPhone={() => {}} />);

    // Tiles: 2 phones (1 quiet), 1 member backing up of 3, refusals in the last 30 days.
    const tiles = await screen.findByLabelText("Device Sync at a glance");
    expect(await within(tiles).findByText("of 3")).toBeInTheDocument();
    expect(within(tiles).getByText("1 quiet")).toBeInTheDocument();
    expect(await within(tiles).findByText("3")).toBeInTheDocument();
    const log = new URL(logQuery, "http://x");
    expect(log.searchParams.get("event")).toBe("photo_sync.refused");
    expect(Date.now() - Date.parse(log.searchParams.get("from") ?? "")).toBeGreaterThan(29 * 86_400_000);

    // Personal libraries against the 2 GB limit: Ann at a quarter.
    const libraries = await screen.findByRole("region", { name: "Personal libraries" });
    expect(await within(libraries).findByRole("meter", { name: "Ann's library, share of the limit used" })).toHaveAttribute("aria-valuenow", "25");
    expect(within(libraries).getByText(/^13% of the room they may use · 2 GB each$/)).toBeInTheDocument();

    // Only these two cards: no Members, no Allowed networks. One page each: no pager.
    expect(screen.queryByRole("region", { name: "Members" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Allowed networks" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("pages the devices ten at a time", async () => {
    const user = userEvent.setup();
    const phones = Array.from({ length: 12 }, (_, index) => phone(index + 1));
    render(<DeviceSyncStats phones={phones} phoneName={(entry) => entry.label} onOpenPhone={() => {}} />);
    const devices = screen.getByRole("region", { name: "Devices" });
    expect(within(devices).getByText("Phone 10")).toBeInTheDocument();
    expect(within(devices).queryByText("Phone 11")).not.toBeInTheDocument();
    const pager = within(devices).getByRole("navigation", { name: "Device pages" });
    await user.click(within(pager).getByRole("button", { name: /2/ }));
    expect(within(devices).getByText("Phone 11")).toBeInTheDocument();
    expect(within(devices).queryByText("Phone 1")).not.toBeInTheDocument();
  });
});
