# Diagnostics pages — one card per part, a page per part, one report dialog (plan)

For isputnik.home's **Infrastructure › Diagnostics** and the containers beside it.
Background: the report (4.89.0, `modules/diagnostics`), `docs/video-hardware-tests-plan.md`
(the video tests, on `preview/hardware-tests`) and `docs/diagnostic-logging-plan.md` (levels).
The agreed mockup is the "Diagnostics, logging and tests" canvas (2026-11-13/14).

Status: agreed 2026-11-14; phase 1 being built on `feat/diagnostics-pages` (from
`preview/hardware-tests` + main). Nothing released.

## In one sentence

**Diagnostics shows one card per part of iSputnik — this server, Video, Games, Faces — with
how it is, its logging and its tests; each card opens that part's own page, where its tests
sit beside what they check; and one Download report button, on the main page and on each
part's page, opens a dialog that says which parts go in and what is hidden.**

## The pages

### Main page (`/control/infrastructure/diagnostics`)

- A card per part, this server first, then each container that is set up (`APPS`).
- Each card: name, version, a status (Healthy · Attention · Not answering · Not set up),
  one line saying what is wrong or how it is, Logging (phase 3), Tests and Details links.
- This server's line comes from its own checks: a library whose folder isn't reachable,
  a library whose last scan failed, no backup for a week or the last one failed.
- A container's line comes from its health check (answers, version, ms) and, when it has
  one, its own diagnostics answer (video: the GPU and the last speed test).
- The header's **Download report** opens the report dialog with every part ticked.

### A part's page (`/control/infrastructure/diagnostics/<part>`)

A page of one thing (like a group's page): its own route, no tab row, a back link.
Status banner, then tiles that jump to its sections, the sections with their tests
inline, and a right-hand column: Logs and events (links to Logs, Activity and Tasks
filtered to that part — `?application=`), and Recent runs.

- **iSputnik:** Libraries (Check folders), Backups (Verify the last backup), The way in
  (Speed to this device), Server; the right column adds **Other containers**: each
  one's health, how fast it answers, and the gateway's calls to it today and how many
  failed (needs counters in `modules/apps/gateway.ts`, phase 2).
- **Video:** Hardware acceleration (the GPU found, what it decodes/encodes, tone-map and
  subtitles, and the transcoding settings — the SAME settings as Videos › Settings, not a
  copy), Conversion speed and Disks (the hardware test page, moved here), Conversion disk.
- **Games, Faces:** status and log links only until they have tests.

### The report dialog (shared `Modal`, `panel`)

- **Which parts:** this server's sections (server and machine, containers, libraries,
  failures) and each container's. From a part's page only that part is ticked.
- **Hide in the file**, each its own switch, all on: names of people (accounts, emails),
  folders and file paths, names of libraries and collections, addresses (IPs, hosts).
  Passwords, keys and tokens are never in a report to begin with.
- **How it will look:** the real report text, as it will be saved, updating with the switches.
- **Copy** and **Download** (a .txt, as today); **Open a bug report** stays.
- "How far back" and logs/events/tests as separate kinds wait for phase 3, when there are
  log lines worth choosing between.

## Server

- `GET /api/admin/diagnostics?parts=…&hide=people,paths,names,net` — `parts` picks the
  sections; `hide` replaces the single `private` switch (`private=true` still means "hide
  nothing", for anyone with the old page open). The redactor gets one switch per kind.
- `GET /api/admin/diagnostics/overview` — the cards: per part `{ id, state, version,
  problems[], line }`. Folder checks are async with a short timeout (a sleeping disk says
  "slow", it doesn't hold the page).

## Phases

1. **Main page by part + report dialog** (home only, no container change): the overview
   route, granular hiding, the cards, the dialog. Details links wait for phase 2; Video's
   Tests opens the existing hardware test page.
2. **Part pages:** iSputnik and Video pages, the hardware test page moved into Video's,
   gateway call counters for Other containers, Games/Faces pages.
3. **Logging** per part (`docs/diagnostic-logging-plan.md`), the cards' Logging menus,
   and the dialog's "How far back".
4. **This server's tests:** Check folders, Verify the last backup, Speed to this device.
