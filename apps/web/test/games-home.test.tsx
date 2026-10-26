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
const { AppsInstalledSection, AppsEventsSection, AppsLogsSection } = await import("../src/features/control/sections/AppsSection");
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

// The admin's window into the games container (docs/apps-platform-plan.md →
// Control panel): status from this server on Apps → Installed, events and the
// log tail from the games server through the gateway on Events and Logs.
const gamesOn = {
  id: "games", kind: "app", prefix: "/games",
  configured: true, reason: null, url: "http://isputnik-games:4200", secretSet: true, secretAccepted: true,
  server: { ok: true, version: "0.3.0", error: null }
};
const gamesOff = { ...gamesOn, configured: false, url: null, secretSet: false, secretAccepted: null, server: null };
const appsAnswer = (games: object) => Promise.resolve({ apps: [games] });
const eventsPage = {
  events: [
    { id: 2, at: "2026-10-22T18:09:35.000Z", level: "warn", event: "gateway.rejected", actorId: null, actorName: null, matchId: null, ip: "172.18.0.9", requestId: "req-7", detail: "GET /games/api/me: no gateway header" },
    { id: 1, at: "2026-10-22T18:00:00.000Z", level: "info", event: "match.created", actorId: "mum", actorName: "Мама", matchId: "m1", ip: "192.168.2.10", requestId: "home-3", detail: "dots: invited Dad (dad), plays first" }
  ],
  total: 2, page: 1, totalPages: 1, retentionDays: 90, rejected24h: 1
};
const logTail = {
  lines: [
    JSON.stringify({ level: 40, time: Date.UTC(2026, 9, 22, 18, 9, 35), reqId: "req-7", user: null, ip: "172.18.0.9", reason: "no gateway header", msg: "Request refused at the gateway check" }),
    "not json at all"
  ],
  capacity: 500,
  available: true
};
const answerByPath = (path: string) => {
  if (path === "/api/apps/admin/status") return appsAnswer(gamesOn);
  if (path.startsWith("/api/games/guest-invites")) return Promise.resolve({ invites: [] });
  if (path.startsWith("/games/api/admin/events")) return Promise.resolve(eventsPage);
  if (path.startsWith("/games/api/admin/log")) return Promise.resolve(logTail);
  return Promise.reject(new Error(`unexpected ${path}`));
};

describe("Apps → Installed", () => {
  it("reports a working link with the games server's version", async () => {
    mockApi.mockImplementation(answerByPath as never);
    render(<AppsInstalledSection />);
    expect(await screen.findByText("Games are on")).toBeInTheDocument();
    expect(screen.getByText("http://isputnik-games:4200")).toBeInTheDocument();
    expect(screen.getByText("Answering, version 0.3.0")).toBeInTheDocument();
    expect(mockApi).toHaveBeenCalledWith("/api/apps/admin/status");
  });

  it("says plainly when the games server refuses this app's secret", async () => {
    mockApi.mockImplementation(((path: string) =>
      path === "/api/apps/admin/status" ? appsAnswer({ ...gamesOn, secretAccepted: false }) : answerByPath(path)) as never);
    render(<AppsInstalledSection />);
    expect(await screen.findByText("The games server refuses this app's secret")).toBeInTheDocument();
    expect(screen.getByText("Set, but the games server refuses it")).toBeInTheDocument();
    expect(screen.queryByText("Games are on")).not.toBeInTheDocument();
  });

  it("asks nothing of the games while the link is off", async () => {
    mockApi.mockImplementation((() => appsAnswer(gamesOff)) as never);
    render(<AppsInstalledSection />);
    expect(await screen.findByText("Games are off")).toBeInTheDocument();
    expect(mockApi).toHaveBeenCalledTimes(1);
  });

  it("says why the games are off, in the server's own words", async () => {
    mockApi.mockImplementation((() => appsAnswer({
      ...gamesOff, reason: "GAMES_URL is set but GAMES_GATEWAY_SECRET is not; games stays off until both are set.",
      url: "http://isputnik-games:4200"
    })) as never);
    render(<AppsInstalledSection />);
    expect(await screen.findByText("Games are off")).toBeInTheDocument();
    expect(screen.getByText(/GAMES_GATEWAY_SECRET is not/)).toBeInTheDocument();
    expect(screen.getByText("Not checked while the gateway is off")).toBeInTheDocument();
  });
});

describe("Apps → Events and Logs", () => {
  it("shows the games container's events, asked through the gateway", async () => {
    mockApi.mockImplementation(answerByPath as never);
    render(<AppsEventsSection />);
    expect(await screen.findByText("1 caller was refused at the gateway check in the last 24 hours.")).toBeInTheDocument();
    expect(screen.getByText("gateway.rejected")).toBeInTheDocument();
    expect(screen.getByText("dots: invited Dad (dad), plays first")).toBeInTheDocument();
    expect(screen.getByText("Мама")).toBeInTheDocument();
    expect(screen.getByText("192.168.2.10")).toBeInTheDocument();
    expect(mockApi).toHaveBeenCalledWith("/games/api/admin/events?page=1&pageSize=25");
    // One container needs no picker.
    expect(screen.queryByLabelText("App")).not.toBeInTheDocument();
    // The level filter asks again with the level.
    await userEvent.selectOptions(screen.getByLabelText("Level"), "warn");
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/games/api/admin/events?page=1&pageSize=25&level=warn"));
  });

  it("shows the log tail with pino's JSON made readable", async () => {
    mockApi.mockImplementation(answerByPath as never);
    render(<AppsLogsSection />);
    const log = await screen.findByLabelText("Server log");
    expect(mockApi).toHaveBeenCalledWith("/games/api/admin/log?lines=200");
    expect(log.textContent).toContain("WARN   [req-7] 172.18.0.9  Request refused at the gateway check — no gateway header");
    expect(log.textContent).toContain("not json at all");
  });

  it("asks no container while none answers, and says where to look", async () => {
    mockApi.mockImplementation((() => appsAnswer(gamesOff)) as never);
    render(<AppsEventsSection />);
    expect(await screen.findByText("No app is answering")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Installed" })).toHaveAttribute("href", "/control/apps");
    expect(mockApi).toHaveBeenCalledTimes(1);
  });
});
