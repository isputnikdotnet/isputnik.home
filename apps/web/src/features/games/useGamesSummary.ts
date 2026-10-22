import { useEffect, useState } from "react";
import { api } from "../../api";
import { useGamesAvailable } from "../../app/useGamesAvailable";

// What is waiting on this person in the games (isputnik.games, behind /games —
// docs/games-platform-plan.md): invitations to answer and matches where it is
// their move. Asked of the games server itself, through the gateway, so this app
// stores nothing about matches; it only shows the count on the Games entry and
// the cards on For you.
//
// Refreshed on mount, when the window regains focus, once a minute while open,
// and whenever a card here acts (refreshGamesSummary). Off entirely — no request
// at all — on an install without the games.

export interface GameInvitation {
  id: string;
  game: string;
  from: { id: string; name: string };
  createdAt: string;
}

export interface GameTurn {
  id: string;
  game: string;
  opponent: { id: string; name: string };
  updatedAt: string;
}

export interface GamesSummary {
  invitations: GameInvitation[];
  yourMove: GameTurn[];
  counts: { invitations: number; yourMove: number };
}

const CHANGED = "isputnik:games-summary";
const REFRESH_MS = 60_000;

/** Tell every mounted copy of this hook to re-check (after answering a card). */
export function refreshGamesSummary(): void {
  window.dispatchEvent(new Event(CHANGED));
}

/** The games are their own app behind /games: every link to them is a full
 *  navigation, never a route of this SPA. */
export function gamesHref(path = ""): string {
  return path ? `/games/${path}` : "/games/";
}

export function gameMatchHref(game: string, matchId: string): string {
  return gamesHref(`${encodeURIComponent(game)}/m/${encodeURIComponent(matchId)}`);
}

/** null until the first answer arrives, and always null without the games. */
export function useGamesSummary(): GamesSummary | null {
  const on = useGamesAvailable();
  const [summary, setSummary] = useState<GamesSummary | null>(null);

  useEffect(() => {
    if (!on) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      api<GamesSummary>("/games/api/summary")
        .then((payload) => { if (!cancelled) setSummary(payload); })
        // A count that cannot be fetched is simply not shown — never an error.
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    window.addEventListener("focus", load);
    window.addEventListener(CHANGED, load);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
      window.removeEventListener(CHANGED, load);
    };
  }, [on]);

  return summary;
}

/** How many things wait: the number on the Games entry. */
export function gamesWaiting(summary: GamesSummary | null): number {
  return summary ? summary.counts.invitations + summary.counts.yourMove : 0;
}
