import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Keep ready (docs/video-cache-plan.md C3): an admin's dialog on a film's or
// show's page, over the video engine's /admin/keep-ready.

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});

const { api, ApiError } = await import("../src/api");
const { KeepReadyModal } = await import("../src/features/video/KeepReadyModal");
const mockApi = vi.mocked(api);

const marked = {
  id: "season:show1:2", kind: "season", targetId: "show1", season: 2, rungs: [720], newEpisodes: false, title: "Show · Season 2",
  total: 10, ready: 4, asIs: 0, waiting: 6, missing: 0, sizeBytes: 6 * 1024 ** 3, estimateBytes: 9 * 1024 ** 3,
  making: { title: "Show S02E05", rung: 720, progress: 0.42 }
};

beforeEach(() => mockApi.mockReset());

describe("keep ready", () => {
  it("starts at 720p, and sends the qualities and whether new episodes follow", async () => {
    const calls: { method: string; body?: string }[] = [];
    mockApi.mockImplementation((async (_path: string, options?: RequestInit) => {
      calls.push({ method: options?.method ?? "GET", body: options?.body as string | undefined });
      return { available: true, titles: [] };
    }) as never);
    const onClose = vi.fn();
    render(<KeepReadyModal kind="show" id="show1" name="Show" onClose={onClose} />);
    const hd = await screen.findByRole("switch", { name: "1080p" });
    expect(screen.getByRole("switch", { name: "720p" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(hd);
    await userEvent.click(screen.getByRole("switch", { name: /New episodes too/ }));
    await userEvent.click(screen.getByRole("button", { name: "Keep ready" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(JSON.parse(calls.find((call) => call.method === "PUT")!.body!)).toEqual({ kind: "show", id: "show1", rungs: [720, 1080], newEpisodes: false });
  });

  it("shows how a marked season stands, and stops keeping it ready", async () => {
    const calls: { path: string; method: string }[] = [];
    mockApi.mockImplementation((async (path: string, options?: RequestInit) => {
      calls.push({ path, method: options?.method ?? "GET" });
      return { available: true, titles: [marked] };
    }) as never);
    const onClose = vi.fn();
    render(<KeepReadyModal kind="season" id="show1" season={2} name="Show · Season 2" onClose={onClose} />);
    expect(await screen.findByText("4 of 10 kept")).toBeInTheDocument();
    expect(screen.getByText("making Show S02E05, 42%")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /New episodes too/ })).toHaveAttribute("aria-checked", "false");
    await userEvent.click(screen.getByRole("button", { name: "Stop keeping ready" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.find((call) => call.method === "DELETE")!.path).toBe("/video/api/admin/keep-ready?id=season%3Ashow1%3A2");
  });

  it("says when there is no room, and when nothing can be kept", async () => {
    mockApi.mockImplementation((async (_path: string, options?: RequestInit) => {
      if (options?.method === "PUT") {
        throw new ApiError("Not enough room for kept video", 409, { code: "room", neededBytes: 60 * 1024 ** 3, limitBytes: 50 * 1024 ** 3 });
      }
      return { available: true, titles: [] };
    }) as never);
    render(<KeepReadyModal kind="movie" id="m1" name="Film" onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole("button", { name: "Keep ready" }));
    expect(await screen.findByText(/more than the room for kept video allows/)).toBeInTheDocument();
  });
});
