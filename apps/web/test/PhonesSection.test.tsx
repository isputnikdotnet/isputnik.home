import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PhonesSection } from "../src/features/profile/PhonesSection";

vi.mock("../src/api", () => ({ api: vi.fn() }));
const { api } = await import("../src/api");
const mockApi = vi.mocked(api);

// Profile › My library › Phones (docs/photo-sync-plan.md, phase 4): each phone says
// how its backup is going, and a problem stands out until photos arrive again.
const phone = (status: Record<string, unknown> | null) => ({
  unavailable: null,
  maxPhones: 20,
  phones: [{ id: "p1", label: "Galaxy Tab", createdAt: "2026-11-05T10:00:00.000Z", lastSeen: "2026-11-05T16:05:00.000Z", lastIp: "192.168.1.36", status }]
});

const working = {
  lastContact: "2026-11-05T16:05:00.000Z",
  lastReceived: "2026-11-05T16:05:00.000Z",
  day: { files: 1, bytes: 2048 },
  total: { files: 44, bytes: 228 * 1024 * 1024 },
  problem: null
};

beforeEach(() => { mockApi.mockReset(); });

describe("a phone's status", () => {
  it("shows today's and all-time counts", async () => {
    mockApi.mockResolvedValueOnce(phone(working));
    render(<PhonesSection />);
    expect(await screen.findByText(/Last 24 hours: 1 file/)).toBeInTheDocument();
    expect(screen.getByText(/In all: 44 files, 228/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a problem newer than the last file as a notice", async () => {
    mockApi.mockResolvedValueOnce(phone({ ...working, problem: { code: "type", detail: ".dng", at: "2026-11-05T17:00:00.000Z" } }));
    render(<PhonesSection />);
    expect(await screen.findByText("File type not allowed: .dng")).toBeInTheDocument();
    expect(screen.getByText(/^Problem on/)).toBeInTheDocument();
  });

  it("keeps an older problem as a quiet line once photos arrive again", async () => {
    mockApi.mockResolvedValueOnce(phone({ ...working, problem: { code: "disk_full", detail: null, at: "2026-11-05T12:00:00.000Z" } }));
    render(<PhonesSection />);
    expect(await screen.findByText(/Earlier problem .*The server's disk is full\./)).toBeInTheDocument();
    expect(screen.queryByText(/^Problem on/)).not.toBeInTheDocument();
  });

  it("says when a phone has not connected yet", async () => {
    mockApi.mockResolvedValueOnce(phone({ ...working, lastContact: null, lastReceived: null, day: { files: 0, bytes: 0 }, total: { files: 0, bytes: 0 } }));
    render(<PhonesSection />);
    expect(await screen.findByText(/Not connected yet · nothing received yet/)).toBeInTheDocument();
    expect(screen.queryByText(/In all/)).not.toBeInTheDocument();
  });

  // Phase 5: the server says when a problem is over, a week without contact is said,
  // and a library near its size limit warns on every phone.
  it("follows the server on whether a problem is over", async () => {
    // Over although no file came after it (a VPN refusal ended by the next contact).
    mockApi.mockResolvedValueOnce(phone({ ...working, lastReceived: "2026-11-05T10:00:00.000Z", problem: { code: "not_listed", detail: "192.168.12.2", at: "2026-11-05T12:00:00.000Z", current: false } }));
    render(<PhonesSection />);
    expect(await screen.findByText(/Earlier problem .*192.168.12.2/)).toBeInTheDocument();
    expect(screen.queryByText(/^Problem on/)).not.toBeInTheDocument();
  });

  it("says when a phone has been out of touch for a week", async () => {
    const lastContact = new Date(Date.now() - 9 * 86_400_000).toISOString();
    mockApi.mockResolvedValueOnce(phone({ ...working, lastContact, stale: true }));
    render(<PhonesSection />);
    expect(await screen.findByText("No contact for 9 days")).toBeInTheDocument();
    expect(screen.getByText(/Open PhotoSync on it/)).toBeInTheDocument();
  });

  it("warns on each phone when the library is nearly full", async () => {
    mockApi.mockResolvedValueOnce({ ...phone(working), usage: { usedBytes: 93 * 1024 ** 3, limitBytes: 100 * 1024 ** 3, nearLimit: true, atLimit: false } });
    render(<PhonesSection />);
    expect(await screen.findByText(/Your library is 93% full. Backups stop at 100/)).toBeInTheDocument();
  });
});
