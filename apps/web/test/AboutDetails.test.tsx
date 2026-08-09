import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AboutDetails, type AboutInfo } from "../src/shared/AboutDetails";

vi.mock("../src/api", () => ({ api: vi.fn() }));
const { api } = await import("../src/api");
const mockApi = vi.mocked(api);

// /api/about used to carry all 206 releases — a few hundred KB to draw the ten
// that fit on screen. It now sends the newest few plus a total, and the rest
// page in from /api/about/changelog. These tests hold that contract from the
// reader's side: what is on screen, and what gets asked for.
const release = (n: number) => ({ version: `1.0.${n}`, label: `Release ${n}`, changes: [`Change ${n}`] });

const about = (over: Partial<AboutInfo> = {}): AboutInfo => ({
  name: "isputnik.home",
  version: "3.0.5",
  description: "Private self-hosted family media library.",
  runtime: "Node.js v24",
  database: "SQLite (WAL mode)",
  server: "Fastify + TypeScript",
  frontend: "React + TypeScript",
  versionUpdates: [release(1), release(2)],
  versionUpdatesTotal: 2,
  ...over
});

beforeEach(() => mockApi.mockReset());

describe("AboutDetails changelog", () => {
  it("shows the releases it was given", () => {
    render(<AboutDetails about={about()} />);
    expect(screen.getByText("v1.0.1")).toBeInTheDocument();
    expect(screen.getByText("Release 2")).toBeInTheDocument();
  });

  it("offers no 'show earlier' button when there is nothing earlier", () => {
    render(<AboutDetails about={about()} />);
    expect(screen.queryByRole("button", { name: /Show earlier/ })).not.toBeInTheDocument();
  });

  it("counts the releases still to come in the button", () => {
    render(<AboutDetails about={about({ versionUpdatesTotal: 40 })} />);
    expect(screen.getByRole("button", { name: "Show earlier versions (38)" })).toBeInTheDocument();
  });

  it("asks for the next page from where the list ends", async () => {
    mockApi.mockResolvedValueOnce({ versionUpdates: [release(3)] });
    render(<AboutDetails about={about({ versionUpdatesTotal: 40 })} />);

    await userEvent.click(screen.getByRole("button", { name: /Show earlier/ }));

    expect(mockApi).toHaveBeenCalledWith("/api/about/changelog?offset=2&limit=25");
    await waitFor(() => expect(screen.getByText("Release 3")).toBeInTheDocument());
  });

  it("appends each page and counts down, then stops offering more", async () => {
    mockApi
      .mockResolvedValueOnce({ versionUpdates: [release(3), release(4)] })
      .mockResolvedValueOnce({ versionUpdates: [release(5)] });
    render(<AboutDetails about={about({ versionUpdatesTotal: 5 })} />);

    await userEvent.click(screen.getByRole("button", { name: "Show earlier versions (3)" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Show earlier versions (1)" })).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /Show earlier/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Show earlier/ })).not.toBeInTheDocument());

    expect(screen.getByText("Release 5")).toBeInTheDocument();
    // second page asked from after the first
    expect(mockApi).toHaveBeenLastCalledWith("/api/about/changelog?offset=4&limit=25");
  });

  it("says so when a page cannot be fetched, and lets you try again", async () => {
    mockApi.mockRejectedValueOnce(new Error("offline"));
    render(<AboutDetails about={about({ versionUpdatesTotal: 40 })} />);

    await userEvent.click(screen.getByRole("button", { name: /Show earlier/ }));

    await waitFor(() => expect(screen.getByText(/Could not load earlier versions/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Show earlier/ })).toBeEnabled();
  });

  it("never asks for more than the server's per-request cap", async () => {
    mockApi.mockResolvedValueOnce({ versionUpdates: [] });
    render(<AboutDetails about={about({ versionUpdatesTotal: 999 })} />);

    await userEvent.click(screen.getByRole("button", { name: /Show earlier/ }));

    // core/status.ts caps limit at 50 and silently falls back to its default
    // past that, so a page size above the cap would quietly page in the wrong
    // size forever.
    const asked = Number(/limit=(\d+)/.exec(String(mockApi.mock.calls[0][0]))?.[1]);
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThanOrEqual(50);
  });
});
