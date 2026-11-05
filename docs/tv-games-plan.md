# Family games on the TV app — plan (2026-11-04)

The TV app (`isputnik.tv`, v0.7.0) has video only. `docs/tv-app-plan.md` put Games under
"Not now" because the games are web pages built for touch and mouse. This plan looks at what
it would actually take, and proposes a way to do it.

## Decision and what was built (2026-11-04)

The owner chose the four games that suit a remote best — **Chess, Checkers, Sputnik Catch,
Torpedo Run** — and native screens. Built the same day, uncommitted and unreleased, checked
on the phone emulator set to a TV shape against a scratch copy of home (port 4012) and the
dev games server:

- **Games server**: not "computer matches" in the database as proposed below, but a
  stateless `POST /games/api/play` (`apps/server/src/play.ts`): the TV sends the options and
  the moves so far, and, against the computer, its seat and level. The server replays them
  and answers with the position, the legal moves and the computer's reply. Nothing is
  stored, so stats, the summary and the matches table are unchanged. Results go through the
  existing `/computer-results`. Only games without hidden information can be played this
  way, because the client holds the moves. `GET /matches/:id?legal=1` adds the legal moves
  on your turn. Hard chess takes about 0.1 s on the server, so no worker thread is needed.
  Tests: `test/play.test.ts`.
- **Art and fixtures**: `scripts/export-tv.ts` in the games repo writes the Sputnik LCD (cut
  into backdrop + 70 segments) and the chess pieces into the TV's assets, plus 10 golden
  arcade runs into its test resources.
- **TV** (`feature-games`): the Games menu entry, shown when `/api/games/status` allows it.
  - The lobby has three rows: Waiting for you, Games, and Your games.
  - Chess and Checkers start from a setup page: your side; the computer at Easy, Normal or
    Hard; two on this TV; or a family member.
  - One board screen serves both games. It has a D-pad cursor that picks a piece and then
    where it goes (each landing in turn for a checkers capture), a promotion picker, and a
    side panel. A game on this TV is kept per person and offers Continue.
  - Online matches poll every 2.5 s, or every 10 s while it's your move.
  - Sputnik Catch and Torpedo Run run Kotlin ports of the engine's tick rules.
    `ArcadeGoldenTest` replays the engine's runs field by field. Live runs (0 and 300 points)
    were accepted by the server's replay.
- **Home**: no code change. A device session goes through the games gateway like a browser's.

Open: the owner's look at it on the Fire TV (a release build; a debug build is slow there);
sound; the family-member row could show the actual board on the waiting tile; release (games
first, then the TV app).

## In one sentence

A native **Games** section in the TV app (Kotlin, Compose for TV) that draws each board itself
and plays every game — against the computer, two people on the sofa, or online against
someone on their phone — **through the games server's match API**. The games server takes on
the computer's moves and gains a sofa mode. Home doesn't change.

## What the investigation found

**Signing in already works.** The TV holds an ordinary home session (kind `device`, from Link
a device) in its cookie jar, and already calls `/video/api/…` through the same gateway
(`modules/apps/gateway.ts`) that serves `/games/…`. The gateway runs `authenticate` and then
forwards the person's identity headers, so games would get the person picked on the TV
("who's watching"), with their role. The TV's `ApiClient` already sends home's CSRF token and
`Origin` on POSTs, so match moves would pass the double-submit check too. **No new token, no
new scope, no home route.** The members list (`GET /api/games/members`) and the invitation
count (`/games/api/summary`) are calls the TV can make as they are.

**Online play already allows a TV opponent.** A match is a row between two member ids, and the
server is the authority: it replays the moves, checks each new one (`applyMove`), and sends each
seat its own view (`viewFor` hides the other fleet or hand). Both clients poll. A TV client is
just one more client: it can send an invitation, accept one, move and resign. The phone or
browser on the other side sees nothing different. Guest links stay a web thing (sharing a
link from a TV makes no sense).

**What's local to the browser today, and can't simply move to the TV:**
- **Computer opponents** run in the browser from the TS engine (`packages/engine`, ~5,000
  lines: rules and AI for every game). Chess "hard" searches up to 1.2 million positions;
  Node does that in a second or two, but a JS interpreter on a Fire TV stick (QuickJS, say) would
  take tens of seconds. And porting the rules and AI to Kotlin would give two copies to keep
  in agreement with the server.
- **Same-screen games** ("local" mode: Dots, Chess, Checkers) are also browser-only.
  The server refuses a match against yourself.
- **Board input** is mouse and touch only (click a square, drag a piece). Only the two arcade
  games (Sputnik Catch, Torpedo) answer the arrow keys today. So a remote needs a cursor in
  every board game, **whichever way we go**.

## 1. Native screens or a WebView? Recommended: native

| | Native Compose | WebView of the games web app |
|---|---|---|
| Sign-in | Already done (`ApiClient`) | Copy the session cookies into `CookieManager`; it works, but the WebView then holds a full home session and can reach every home page from the games' top bar |
| D-pad | The app's own focus model (`remembersFocus`, `FocusMemory`), as in video | Android WebView has no spatial navigation. Every page needs its own key handling, a "TV mode" CSS (10-foot sizes, focus rings, no top bar and no phone tab bar), and Back passed between the WebView and the native shell |
| Look | Matches the rest of the TV app (navy, teal focus ring) | The games' look, in a frame |
| Fire TV stick | Fast; boards are simple Canvas drawings | Amazon's WebView runs a React SPA well enough for turn-based games, but a heavier first load, and SVG animation is less smooth |
| Work | A board, a cursor and a panel per game, in Kotlin | A cursor per game in React, plus the TV mode and the shell glue; less drawing |
| Rules | On the server (see below), one copy | Unchanged, one copy |

The D-pad cursor is needed either way, so the WebView's saving is mostly the drawing. Against
that: the owner chose **fully native** for this app (2026-10-30, "not a WebView over React"),
the focus and Back behaviour would be the hardest part to get right in a WebView, and
the games would look different from everything else on the TV. **Recommendation: native.**

**Rules stay in one place: the games server.** The TV draws the state the server sends and
sends moves back. It needs no engine. Two additions on the games server make that possible
for every mode:

- **Computer matches on the server**: a match whose second seat is the computer at a level.
  After each move by the person, the server plays the computer's reply (in a worker thread, so
  a hard chess search never blocks other requests). Because `viewFor` applies, the TV never
  receives the computer's hand or fleet.
- **Sofa matches**: one member at both seats, for two people sharing a remote (the games
  that have hot seat today: Dots, Chess, Checkers).
- **Legal moves in the match detail**, for the seat to move (`legalMoves` already exists on
  every `GameDefinition`), so the TV can highlight where a piece can go without knowing the
  rules.

One API for all three modes. As a bonus, a computer game started on the TV is a server match,
so it survives a restart. The web app keeps its local games as they are.

The arcade games are the exception: they run at 20 ticks a second, so their rules have to run
on the TV. Sputnik Catch (~210 lines) and Torpedo (~360) are small and pure. A Kotlin port
can be checked against the server, which already replays every run from its seed and input
log (`arcade_scores`). A port that drifts would get its scores refused. Golden replays recorded
from the TS engine would be the test.

## 2. Which games suit a remote and a sofa

| Game | Fit | With D-pad + OK | Modes on TV |
|---|---|---|---|
| **Chess** | Very good | Cursor on 8×8; OK picks a piece (its moves light up), OK again drops it | Computer, sofa, online |
| **Checkers** | Very good | Same as chess; forced captures highlighted | Computer, sofa, online |
| **Sputnik Catch** | Very good | Already the four arrows; OK starts | Arcade (scores to the family board) |
| **Torpedo** | Good | Left/right to aim, OK to fire | Arcade |
| **Dots** | Good on 10/15/20, slow on 25/30 | Cursor on the points; holding an arrow repeats. Offer the smaller sizes first on TV | Computer, sofa, online |
| **Dominoes** | Good | Left/right through the hand, OK, then which end | Computer, online. The hand is visible to the room, which is fine for a family |
| **Star Battle** | Fair | Laying the fleet by cursor + rotate is fiddly, so offer "place at random" first; shooting is a plain 10×10 cursor | Computer, online (never sofa: hidden fleets) |
| **Crossmath** | Poor | Moving tiles into blanks one at a time with a cursor; a puzzle for one, close up | Leave on the phone/web |
| Chess puzzles, review, chat | Poor / no | Typing and studying | Show the move log; no chat input |

Chess and Checkers first: they are the best fit and share one board component, cursor
and set of pieces.

## 3. Playing someone on their phone

Yes, as shown above: the match model needs nothing new for it. The TV person picks a game and
a family member; the other person sees the invitation on the games lobby and home's For you
(phase A already shows "your move" there), and plays from their phone. The TV shows
"Waiting for you" (invitations, your move) at the top of its Games page, from
`/games/api/summary`, polled like the web app does (2.5 s in a match, 60 s elsewhere).
The 2.5 s poll is good enough for turn games; a live stream (SSE) stays on the games plan's
open list and isn't needed for this.

## 4. What each repository needs

**isputnik.home: nothing for the code.** Auth, CSRF, members list and gateway all work as they
are. Docs only: the TV guide (`docs/users/tv-app.md`) gains a Games part, and
`docs/tv-app-plan.md`'s "Games: Not now" row points here.

**isputnik.games (server):**
- Matches against the computer: a `computer_level` column (migration); `POST /matches` with
  `opponent: { computer: level }`, created as already accepted; the AI move played after each
  human move, in a `worker_threads` pool of one; resign and finish as now.
- Sofa matches: `opponent: "self"` (`both seats = me`), the person always to move.
- Match detail gains `legalMoves` for the seat to move, when the requester holds that seat.
- Stats: a finished computer match writes `computer_results` itself, so a TV win counts on the
  vs Computer board like a browser's. Computer and sofa matches stay out of
  "Each other" and Recent games between members, and out of `/summary`'s your-move count.
- Tests for each, and in `docs/plan.md` the TV as a client.

**isputnik.tv:**
- `feature-games` module: a `GamesFeature` with one menu entry, **Games**, shown when
  `/api/games/status` says the section is on and the person may play. `GamesApi` over the
  match routes.
- Games page: Waiting for you (accept / decline / play), the games as tiles, then New game:
  computer (level), sofa, or a family member.
- A shared board kit: a grid cursor with key repeat, highlight layers, a side panel (whose
  move, score, the last few log lines, Resign / Offer draw), Back = leave the match (it's
  saved on the server, so nothing is lost).
- One board per game, each with the server's state as JSON and moves sent as the game's move
  JSON (the same shapes `parseMove` accepts).
- Sound later, if at all: native short tones, off by default.

## Phases

| Phase | What | Repos | Done when |
|---|---|---|---|
| **G0** | **Spike**: a Compose chess board with a D-pad cursor, playing a stand-in computer endpoint on the dev games server, on the Fire TV | tv, games (throwaway) | Moving a piece with the remote feels right on the sofa; a hard move returns in a few seconds. **If not, rethink before G1** |
| **G1** | Server: computer + sofa matches, `legalMoves`, stats. TV: Games menu, Games page, Chess and Checkers in all three modes | games, tv, home docs | The owner plays chess on the TV against the computer and against someone on their phone; the win shows on the family board |
| **G2** | Dots, Dominoes, Star Battle | tv (games only if a game needs a tweak) | All five board games play from the TV |
| **G3** | Sputnik Catch and Torpedo: Kotlin port of the tick rules with golden replays; scores sent as from the web | tv, games (golden-replay fixtures) | A TV run's score is accepted by the server and shows on the leaderboard |
| Later | Crossmath, chess puzzles, sound, a QR for inviting a guest | — | Each decided on its own |

G1 is the big one, about the size of T2. G2 is mostly drawing. G3 is independent of G2 and
can go first if the arcade matters more.

## Open questions for the owner

1. **Native (recommended) or WebView?** Native matches your 2026-10-30 decision for the app.
2. **Computer games played on the server (recommended)?** It keeps one copy of the rules and
   the AI, and it means the TV can't play games without reaching the server. The TV can't
   play video without it either.
3. **Sofa games** (two people, one remote, pass it on): wanted? Cheap once computer matches
   exist.
4. **Start with Chess + Checkers (recommended), or with the arcade games** (Sputnik Catch fits
   a remote best of all, but needs the rules ported)?
5. **Hidden hands on a shared screen**: Dominoes and Star Battle online from the TV show your
   tiles or fleet to the room. Acceptable for a family?
6. **Chat**: show the match log read-only on the TV, with no way to type? Recommended.
7. **Should a computer game started on the TV also appear on the phone's games page** so it
   can be finished there? It would be free on the server side, but the web app would need to open
   a computer match from the server rather than its local save. Recommended: not in G1.
