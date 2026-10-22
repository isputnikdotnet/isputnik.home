import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "../src/api";
import { renderSignedIn } from "./helpers/session";

// The games' presence in the home app (docs/games-platform-plan.md, phase A):
// the count and cards come from the games server through the gateway, and
// the admin's tab reads status.

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});
const gamesAvailable = vi.fn(() => true);
vi.mock("../src/app/useGamesAvailable", () => ({ useGamesAvailable: () => gamesAvailable() }));

const { api } = await import("../src/api");
const { InvitationRow, YourMoveRow } = await import("../src/features/games/GameRows");
const { useGamesSummary, gamesWaiting } = await import("../src/features/games/useGamesSummary");
const { GamesSection } = await import("../src/features/control/sections/GamesSection");
const mockApi = vi.mocked(api);

const member = (over: Partial<PublicUser> = {}): PublicUser =>
  ({ id: "mum", displayName: "Mum", role: "member", theme: "minimalist", ...over }) as PublicUser;

function Waiting() {
  const summary = useGamesSummary();
  return <output>{gamesWaiting(summary)}</output>;
}

beforeEach(() => {
  mockApi.mockReset();
  gamesAvailable.mockReturnValue(true);
});

describe("useGamesSummary", () => {
  it("asks the games server through the gateway and adds up what waits", async () => {
    mockApi.mockResolvedValue({
      invitations: [{ id: "i1", game: "dots", from: { id: "dad", name: "Dad" }, createdAt: "2026-10-22T10:00:00.000Z" }],
      yourMove: [
        { id: "m1", game: "dots", opponent: { id: "dad", name: "Dad" }, updatedAt: "2026-10-22T10:00:00.000Z" },
        { id: "m2", game: "dots", opponent: { id: "kid", name: "Kid" }, updatedAt: "2026-10-22T09:00:00.000Z" }
      ],
      counts: { invitations: 1, yourMove: 2 }
    });
    renderSignedIn(<Waiting />, { user: member() });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("3"));
    expect(mockApi).toHaveBeenCalledWith("/games/api/summary");
  });

  it("never asks on an install without the games", async () => {
    gamesAvailable.mockReturnValue(false);
    renderSignedIn(<Waiting />, { user: member() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockApi).not.toHaveBeenCalled();
  });
});

describe("the games' cards on For you", () => {
  it("answers an invitation with the row's own buttons", async () => {
    const onAnswer = vi.fn(async () => undefined);
    render(
      <ul>
        <InvitationRow
          card={{ id: "i1", game: "dots", from: { id: "dad", name: "Dad" }, createdAt: "2026-10-22T10:00:00.000Z" }}
          onAnswer={onAnswer}
        />
      </ul>
    );
    expect(screen.getByText("Dad invited you to play")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Dots" })).toHaveAttribute("href", "/games/");
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(onAnswer).toHaveBeenCalledWith(expect.objectContaining({ id: "i1" }), "accept");
    await userEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(onAnswer).toHaveBeenLastCalledWith(expect.objectContaining({ id: "i1" }), "decline");
  });

  it("opens the match where it is your move, as a full navigation into the games", () => {
    render(
      <ul>
        <YourMoveRow card={{ id: "m1", game: "dots", opponent: { id: "dad", name: "Dad" }, updatedAt: "2026-10-22T10:00:00.000Z" }} />
      </ul>
    );
    expect(screen.getByText("Your move against Dad")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Play" })).toHaveAttribute("href", "/games/dots/m/m1");
  });
});

describe("Settings → Games", () => {
  it("reports a working link with the games server's version", async () => {
    mockApi.mockResolvedValue({
      configured: true, reason: null, url: "http://isputnik-games:4200", secretSet: true,
      server: { ok: true, version: "0.2.0", error: null }
    });
    render(<GamesSection />);
    expect(await screen.findByText("Games are on")).toBeInTheDocument();
    expect(screen.getByText("http://isputnik-games:4200")).toBeInTheDocument();
    expect(screen.getByText("Answering, version 0.2.0")).toBeInTheDocument();
    expect(mockApi).toHaveBeenCalledWith("/api/games/admin/status");
  });

  it("says why the games are off, in the server's own words", async () => {
    mockApi.mockResolvedValue({
      configured: false, reason: "GAMES_URL is set but GAMES_GATEWAY_SECRET is not; the games stay off until both are set.",
      url: "http://isputnik-games:4200", secretSet: false, server: null
    });
    render(<GamesSection />);
    expect(await screen.findByText("Games are off")).toBeInTheDocument();
    expect(screen.getByText(/GAMES_GATEWAY_SECRET is not/)).toBeInTheDocument();
    expect(screen.getByText("Not checked while the gateway is off")).toBeInTheDocument();
  });
});
