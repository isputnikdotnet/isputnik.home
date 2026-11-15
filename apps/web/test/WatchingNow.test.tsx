import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WatchingNow } from "../src/features/control/diagnostics/Watching";

vi.mock("../src/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/api")>()), api: vi.fn() }));
const { api } = await import("../src/api");
const mockApi = vi.mocked(api);

// Diagnostics › Video's Watching now: each play with who, what, how it reaches
// them, on what and from where.
beforeEach(() => mockApi.mockReset());

describe("Watching now", () => {
  it("lists each play, played as it is or converted", async () => {
    mockApi.mockResolvedValue({ plays: [
      { kind: "direct", user: "Mum", itemId: "a", title: "Радар S01E02", network: "internet", device: "Phone", since: new Date().toISOString(), bytes: 52_428_800 },
      { kind: "converted", user: "Dad", itemId: "b", title: "Dune", network: "home", device: "TV", since: new Date().toISOString(), mode: "transcode", converter: "gpu", rung: 1080, hdr: true, converting: true, shared: false, kept: false }
    ] });
    render(<WatchingNow prefix="/video" />);
    expect(await screen.findByText("Watching now (2)")).toBeTruthy();
    expect(screen.getByText("Mum · Радар S01E02")).toBeTruthy();
    expect(screen.getByText(/Played as it is · phone · away from home · since .* · 50(\.0)? MB/)).toBeTruthy();
    expect(screen.getByText(/Converted on the GPU · up to 1080p · HDR tone-mapped · TV · at home/)).toBeTruthy();
    expect(mockApi).toHaveBeenCalledWith("/video/api/admin/watching");
  });

  it("says when nobody is watching", async () => {
    mockApi.mockResolvedValue({ plays: [] });
    render(<WatchingNow prefix="/video" />);
    expect(await screen.findByText("Nobody is watching")).toBeTruthy();
  });
});
