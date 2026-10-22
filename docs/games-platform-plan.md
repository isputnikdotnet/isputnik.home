# Games platform plan — isputnik.games

Family games as a project of their own, signed in through isputnik.home. The first
game is Dots (Точки), the paper-and-pencil territory game: two players take turns
placing dots on a grid, and a closed chain of your dots around the opponent's dots
captures them. This page is the plan for the whole platform and the contract the two
projects keep between them; the games' own design lives in the `isputnik.games`
repository.

Status: phase 0 and phase 1 are being built (2026-10-21). Phases 2 and 3 are planned.

## Why a separate project

Games share nothing with a media library except the people playing. Keeping them in
their own repository and Docker image means:

- the home app's release rhythm, test suite and security surface stay untouched — a
  game bug can never take the library down, and a library release never ships game
  code nobody asked for;
- the games can move fast and grow (more games, real-time play) without each change
  being weighed against a 4.x media server;
- the family still signs in once. isputnik.home remains the single front door,
  with every control it already has — MFA outside trusted networks, rate limits,
  auto-block, device sessions, "preview as member".

## The one decision: isputnik.home is the gateway

The session cookie is `__Host-isputnik_sid`: httpOnly, SameSite=Lax and pinned to
the exact origin, so a browser never sends it to another hostname. CSRF is a
per-origin double-submit cookie and CORS allows only `APP_URL`. A games server on
its own hostname would therefore need a single-sign-on handshake, a second session
store and logout sync — real protocol work and new attack surface for a family game.

Instead the games container never faces the network. The home server proxies
`/games/*` to it over the Docker network and, on every proxied request, validates
the session exactly as it does for its own routes, then forwards who is asking:

```
browser ──► isputnik.home (:4000) ──► isputnik.games (:4200, internal only)
             authenticate()            trusts X-Isputnik-* only with the secret
             CSRF check
             rate limit, auto-block
```

What this buys: zero new auth code anywhere, the games work wherever the home app
works (plain LAN on port 4000, Unraid, behind the owner's reverse proxy), one
hostname and one certificate, and the "Games" entry in the nav is a plain link to
`/games/`. If the games ever need to be reachable where the home app is not, a
subdomain with a token handoff is still possible later; nothing here blocks it.

## The contract (what the two projects agree on)

### Request path

Everything under `/games/` on the home origin belongs to the games app: its pages,
its static files (`/games/static/…`) and its API (`/games/api/…`). The home server
proxies the whole prefix unchanged; the games server is built with that prefix as
its base and never answers at `/`.

### Identity headers

The home gateway strips any `X-Isputnik-*` header a client sent (so nobody can
pose as the gateway from outside), then adds:

| Header | Value |
|---|---|
| `X-Isputnik-Gateway` | the shared secret (`GAMES_GATEWAY_SECRET` on the home side, `GATEWAY_SECRET` on the games side) |
| `X-Isputnik-User-Id` | the member's id (home `users.id`) |
| `X-Isputnik-User-Name` | the display name, percent-encoded UTF-8 (Russian names are not header-safe raw) |
| `X-Isputnik-User-Role` | `admin` or `member` |
| `X-Isputnik-User-Lang` | the member's interface language (`en`, `ru`) |
| `X-Isputnik-User-Theme` | the member's theme (`minimalist`, `plain-dark`, `system`, …), so the games wear the same one |

The games server accepts these only when the secret matches; without a matching
secret the request is anonymous (401 from the API). Out of the box the games
container therefore refuses everyone, which is the right default for a service that
must only ever be spoken to by the gateway. In development, with no secret set, the
games server uses a fixed developer identity (`DEV_USER`) so it runs on its own.

### CSRF

The home server's double-submit check runs on the proxied requests too, so the games
front end echoes the home CSRF cookie (`isputnik_csrf`, `__Host-isputnik_csrf` on
HTTPS) in the `X-CSRF-Token` header on every state-changing request — the same
thing the home SPA does. The games server adds no CSRF of its own; it would be
redundant behind the gateway and wrong in development.

### "Preview as member"

An admin previewing as a member reaches the games as that member and can read
everything; writes answer 403 from the gateway, as they do everywhere else.

### Members list (phase 2)

Online play needs "invite a family member". The home app will expose one read
endpoint to the gateway for that: active members' ids, display names and avatars.
Nothing else crosses the boundary; the games app keeps its own data.

## Changes in isputnik.home (phase 0)

- `GAMES_URL` (the upstream, e.g. `http://isputnik-games:4200`) and
  `GAMES_GATEWAY_SECRET`. With `GAMES_URL` unset the gateway is off and the app
  shows no Games entry.
- `modules/games/`: a product module (not core) registering the `/games/*` proxy via
  `@fastify/http-proxy` with `authenticate` as the pre-handler and the header
  rewrite above, plus `GET /api/games/status` → `{ enabled }` for the web app.
- Web: a "Games" entry in the primary nav and the phone Media sheet, shown when the
  gateway is on. It is a plain link (full navigation), not an SPA route.
- Vite dev server proxies `/games` to the home server, like `/api`.
- Documentation: configuration reference, compose example, Unraid template fields.

## isputnik.games (phase 1)

Same stack as the home app so conventions carry over: npm workspaces, Fastify,
React + Vite, Vitest, TypeScript strict, ESLint, Node 26 image on ghcr.io.

```
isputnik.games/
  packages/engine/      pure TypeScript game rules, shared by server and web
    src/game.ts           the GameDefinition interface every game implements
    src/registry.ts       the list of games
    src/dots/             rules.ts (board, captures, end), ai.ts, index.ts
    test/                 rule tests — the capture logic is where the bugs hide
  apps/server/          Fastify: identity from the gateway, /games/api, static web
  apps/web/             React + Vite with base /games/: lobby + one page per game
  Dockerfile, docker-compose.yml, .github/workflows, docs/
```

### Engine shape

Every game is a `GameDefinition<Options, State, Move>` with pure functions:
`createGame(options)`, `legalMoves(state)`, `applyMove(state, move)`, and an
optional `ai.chooseMove(state, level, random)`. State is plain JSON. The same code
runs in the browser for local and computer games and, in phase 2, on the server as
the authority for online games — so the engine never touches the DOM or Node APIs.

### Dots rules (the variant implemented)

- Board sizes 10, 15, 20, 25, 30 (intersections). Blue moves first, red second.
- A move places one dot on an empty point that lies in no territory.
- After a move, every region adjacent to the new dot that cannot reach the board
  edge through non-blue cells (4-connected flood fill, which is the same as being
  ringed by an 8-connected chain of the mover's live dots) and contains at least one
  live opponent dot becomes the mover's territory. Opponent dots inside are
  captured; empty points inside become unplayable. A ringed region with no
  opponent dot inside is not captured and stays open — the Yandex rule.
- Then the new dot is checked the other way: if it sits in a region the opponent
  had already ringed, the opponent captures that region at once (playing into a
  "house" loses the dot).
- Captured dots no longer count as chain material. Ringing a region that contains
  the opponent's territory takes it over, which frees your dots inside and captures
  theirs.
- Edge points cannot be captured, which falls out of the flood-fill definition.
- The game ends when no playable point remains or when a player reaches the
  optional capture target; the local game can also be ended by agreement. Score is
  captured dots.

### Computer opponent

Heuristic, two levels. Easy plays near the action and takes any capture on offer.
Normal looks one reply ahead: for each candidate it weighs captures gained, the
best capture the opponent could answer with, and distance to existing dots, with a
little randomness so games differ. Candidates are points within two steps of an
existing dot, which keeps a 30×30 board under a tenth of a second per move.

### Web app

- `/games/` — lobby: one card per game in the registry.
- `/games/dots` — new game (board size, mode, who the computer plays, capture
  target) and the board: SVG grid, dots, chains drawn as lines between neighbouring dots, captured areas as filled loops, last move marked,
  scores and turn, undo, end game, new game. The game in progress is kept in
  localStorage so a refresh or a phone lock does not lose it.
- Language follows the home app: the same `isputnik-language` localStorage key is
  read first (same origin), else the gateway's header, else the browser.
- Theme tokens are copied from the home app's `tokens.css` so the two look like one
  product; shared components are copied, not published, until a third consumer
  exists.

### Server

- `GET /games/api/health`, `GET /games/api/me`.
- Static serving of the web build under `/games/` with an SPA fallback for
  `/games/*` that is not `/games/api/*`.
- No database in phase 1; the server is a thin host. Phase 2 adds SQLite.
- Image: `node:26-slim`, runs as `node`, port 4200, no volume. Refuses to start in
  production without `GATEWAY_SECRET`.

## Phase 2 — online duels

- SQLite (`better-sqlite3`, WAL) in `/config`: `matches`, `moves`, `invitations`,
  per-game `ratings`. Keyed by home user ids; a departed member shows as "former
  member".
- Match flow: invite a member → they accept → the server holds the authoritative
  state, validates each move with the engine, and pushes the opponent's moves live.
  Server-Sent Events first (they pass through the proxy unchanged); WebSocket if a
  game ever needs two-way streaming, with `websocket: true` on the gateway.
- A match list on the lobby, unfinished matches resumable from any device, and a
  small results history per member.
- Needs the members-list endpoint from the home app (see the contract).

## Phase 3 — more games

Each new game is a folder in `packages/engine/src/<game>/` implementing
`GameDefinition`, a page in `apps/web/src/games/<game>/`, and a line in the
registry. Everything else — identity, matches, invitations, live play — is shared.
Candidates: Battleship (Морской бой), Tic-tac-toe on a big board (Крестики-нолики /
Gomoku), Checkers (Шашки).

## Open points

- Whether local (same-device) results should be recorded at all, or only online
  matches. Starting with online only.
- Where the Games entry sits in the home nav once there are several sections; for
  now it is one item after Stories.
- The Yandex game's exact edge cases (overlapping enclosures, scoring nested
  territories) are not published; the variant above is the common computer one.
