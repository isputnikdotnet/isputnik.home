# Control panel v2 — five groups and application workspaces

Status: **proposed** (2026-11-11). Replaces the six-group design described in
`features/control/nav.ts`, `docs/control-panel-navigation-review.md` and the
"Control panel" paragraph of `CLAUDE.md`. Those rules are retired on purpose
by this effort; they get rewritten in the last phase, not argued with.

## Why

Today a feature's controls are scattered by *kind*: Gallery's duplicate cleanup
is in Maintenance, its maps in Settings, its scan rules on a library's Manage page,
its tasks in Maintenance, its logs in Overview. To find "everything about Gallery"
you have to know the panel's taxonomy first. v2 keeps the system-wide groups for
system-wide things and gives each application one workspace.

## Shape

Left sidebar: five groups. The panel title opens the home dashboard.

| Group | What belongs here |
|---|---|
| *(panel title)* → **Dashboard** | Where an admin lands: needs attention, services, storage, usage, current work (see "Dashboard"). Not a group. |
| 1. **Infrastructure** | Running services and containers, connections, health, versions, technical setup |
| 2. **Libraries & Scanning** | Library folders, content types, scanning rules, exclusions, schedules, device imports |
| 3. **Applications** | Ebooks, Gallery, Audiobooks, Stories, Family Tree, Videos, Games, and future ones |
| 4. **Security & Members** | Members, groups, invitations, permissions, sign-ins, trusted networks, blocked addresses |
| 5. **System Settings** | Storage, backups and recovery, email, notifications, appearance, other system-wide settings |

Groups 1, 2, 4, 5 work as groups do today: a link to the first tab over one row
of tabs.

**Applications is different.** Its landing page is a *directory*: one card per
application with a short description and a status (Ready · Needs setup · Turned
off · Not installed). Choosing one opens its workspace:

```
Applications › Gallery
Setup · Device Sync · Organize · Settings
```

That is the only tab row on screen. There is never a row listing every
application with a second row of workspace tabs under it.

### The workspace vocabulary

Setup · Organize · Settings are a shared vocabulary, **not mandatory tabs** —
each application gets only the tabs it needs (Gallery adds Device Sync):

- **Setup** — prerequisites, connections, links to its libraries. Once
  everything is configured it shrinks to a small status card at the top of the
  workspace's first tab instead of being a tab of its own.
- **Organize** — application-specific organization and cleanup tools.
- **Settings** — how the application behaves.
There is **no Activity tab** inside an application. Activity, Tasks and Logs
live in Infrastructure; an application links there with its filter already
selected ("View Gallery activity") — from the Ready line at the top of its
workspace and from a small "Activity, tasks and logs" card in Setup (running
tasks, failures in the last day, the three links).

A tab with nothing in it is not drawn. An application whose workspace comes down
to one tab draws no tab row. Heavy tools stay sub-pages under their tab
(the 4.73 `pages` mechanism: own address, tab stays selected, back link) —
e.g. Gallery › Organize › Duplicate cleanup.

### Ownership boundaries

An application *shows* and *links*; it does not *own* these:

| Owner | Owns | An application shows |
|---|---|---|
| Libraries & Scanning | scanning configuration | its libraries, each linking to that library's scan settings |
| Infrastructure | service connections | whether its engine/container is connected, linking to that connection |
| Security & Members | permissions | a shortcut to its own access rules |
| System Settings | storage configuration | its usage, linking to the storage details |

Each fact has one editable home; the workspace is a lens over it.

Put as tasks: "change this folder's scan schedule" is a Libraries task; "back up
my phone photos" is a Gallery task.

- **Libraries & Scanning** — which folders supply content, how they are scanned,
  and when.
- **Applications** — how content is imported through application-specific
  workflows (Device Sync), organized, and used.
- **System Settings › Storage** — where system-managed files live and how much
  space they consume.

### Shared controls, several entry points

A shared control can be reached from several places without becoming separate
implementations:

| Feature | Where people find it | Scope |
|---|---|---|
| Device Sync | Applications › Gallery › Device Sync | Photo/video backup and imports |
| Book categories | Applications › Ebooks › Organize; also Audiobooks › Organize | One shared category system, the same editor from both |
| Video genres | Applications › Videos › Organize | Video-only |
| Tags | Each relevant application › Organize | The shared tag manager, opened filtered to that application |
| All tags | Applications › Shared organization | Whole-system tag management |

The tag manager must make the effect of an edit clear: filtering to Gallery does
not mean a rename affects only Gallery. A rename or merge shows when other
applications use that tag ("Also in Stories").

An Organize page lists its tools as described destinations (Tags, Duplicate
cleanup, Missing photos), never another row of tabs. Tools go there only when
they already exist or we explicitly decide to add them.

### Logs, Tasks and Activity

Activity (who used what, usage charts) is an Infrastructure tab beside Tasks
and Logs, with application, member and time filters; applications link to it
filtered, exactly as they do to Logs.

One Logs page (Infrastructure) with filters: **application, service, member,
time, severity**. "View Gallery logs" opens it already filtered. Tasks works
the same way (application, library, status, type). Both pages already read
filters from the query (`logsHref`, `tasksHref` in `features/control/links.ts`);
what's missing is the **application** facet — mapping job types and event names
to an application on the server.

## Where today's pages go

| Today | v2 |
|---|---|
| Overview › Dashboard | **Dashboard** (panel title) |
| Overview › Activity | Infrastructure › Activity |
| Overview › Statistics | Libraries & Scanning › Statistics |
| Overview › Logs | Infrastructure › Logs |
| Library › Libraries (+ Manage pages) | Libraries & Scanning › Libraries |
| Library › Organization › Tags | Applications › Shared organization (+ a filtered link in each app's Organize) |
| Library › Organization › Book categories | Applications › Ebooks › Organize and Audiobooks › Organize (one editor) |
| Library › Organization › Video genres | Applications › Videos › Organize |
| Library › Device Sync | Applications › Gallery › Device Sync |
| Library › Storage, App storage contents | System Settings › Storage (contents a page under it) |
| Members › Users, Groups, Invites | Security & Members |
| Security › all seven tabs | Security & Members |
| Maintenance › Tasks, Scheduled jobs | Infrastructure |
| Maintenance › Backup | System Settings › Backups |
| Maintenance › Recycle bin | System Settings › Recycle bin |
| Maintenance › Duplicate cleanup, Missing photos | Applications › Gallery › Organize (pages) |
| Maintenance › Videos (streaming / GPU) | Infrastructure › Video streaming |
| Settings › Appearance, Email, Notifications, About | System Settings |
| Settings › Quotes | System Settings › Quotes |
| Settings › Maps | Applications › Gallery › Settings |
| Settings › Stories | Applications › Stories › Settings |
| Settings › Apps (pairing) | Infrastructure › Services |
| Settings › Video | Applications › Videos › Settings |
| Appearance › "Sections" card (turn apps on/off) | Each application's status in the directory, with the switch in its Setup |

### First cut of each workspace

| Application | Tabs | Setup | Organize | Settings |
|---|---|---|---|---|
| Gallery | Setup · Device Sync · Organize · Settings | photo libraries, face engine connection, Inbox | Tags, Duplicate cleanup, Missing photos | Maps, Saved places |
| Videos | Setup · Organize · Settings | video libraries, engine connection | Genres | Video settings |
| Ebooks | Setup · Organize | ebook libraries | Book categories, Tags | — |
| Audiobooks | Setup · Organize | audiobook libraries | Book categories, Tags | — |
| Stories | *(one page)* | — | — | Story settings |
| Family Tree | Setup · Organize | — | *(inventory: import/export package)* | — |
| Games | *(one page)* | container connection, access shortcut, guest links | — | — |
| Shared organization | *(one page)* | — | All tags | — |

Gallery has one workspace tab of its own on top of the vocabulary:
**Setup · Device Sync · Organize · Settings**. Device Sync is the
whole of today's page (phones, where their photos go, allowed networks, the
address phones use). A personal library it feeds is still a library: its Manage
page in Libraries & Scanning says "Fed by Device Sync" and links back.

Shared organization is a directory entry, not an application: no status, one
page, no tab row. It holds what crosses applications — today only tags.

Ebooks, Stories, Family Tree and Games will start as one or two tabs. That's
intended: they grow when they have something, they don't get padded.

### Infrastructure / Libraries / Security / Settings tab rows

- **Infrastructure**: Services · Video streaming · Tasks · Scheduled jobs · Logs · Activity
- **Libraries & Scanning**: Libraries · Statistics
- **Security & Members**: Members · Groups · Invites · Overview · Sign-ins · Locations · Policies · Trusted · Blocked · App access
  (ten tabs — consider folding Locations into Sign-ins)
- **System Settings**: Appearance · Email · Notifications · Storage · Backups · Recycle bin · About

## Dashboard

An admin opening the control panel lands on the Dashboard (the panel title
returns to it). It gives the overview and shortcuts; it configures nothing —
System Settings › Storage stays the place for storage locations and policies.
**Every summary leads somewhere useful:**

| Dashboard item | Interaction |
|---|---|
| Service status | Open connection details, health information and troubleshooting |
| Security alert | Open the relevant event with actions appropriate to it (e.g. Block address) |
| Active members | See usage by member and application |
| Running task | Open progress and logs; cancel when supported |
| Usage chart | Select a period or application to narrow the results |
| Storage | Select a drive or category to inspect what occupies it |

Order:

1. **Needs attention** — actionable alerts, most urgent first, each with its
   action button (low space, failed tasks, security events, unavailable
   locations, an application that needs setup).
2. **Running services** — home and each container: status, version, response;
   a tile opens Infrastructure › Services on that service.
3. **Storage** — capacity bars and breakdown (below).
4. **Usage** — interactive trend with period (7 days · 30 days · 12 months)
   and application filters; the most active members, each opening
   Infrastructure › Activity filtered.
5. **Current work** — scans, syncs, imports, backups: progress, "Progress and
   logs", and Cancel only where the task supports it.

### Storage on the dashboard

It answers: how much room is left, what is using it, and what can I do?

- **One capacity bar per physical drive/filesystem** — used, free, total.
  Folders sharing a drive never appear as separate capacities.
- **A usage breakdown** where measurable: library media, app data, thumbnails
  and cache, backups, recycle bin.
- **"Other files"** — drive usage minus what we measured. A disk may hold
  unrelated files; the dashboard never implies our categories explain
  everything.
- **Growth** over the selected period, once there are historical measurements.
  Until then the panel says so; it never draws a made-up trend.
- **Warnings** for low space, unavailable locations and read-only storage —
  also raised in Needs attention.

Clicking a drive opens its folders and libraries. "Backups" opens backup
storage details; "Recycle bin" opens recoverable/deletable items; "Library
media" opens Libraries. Cleanup actions show what will be affected before the
confirmation (ConfirmDialog states the consequence and the space freed).

### What exists and what is new

- **Drives**: `modules/dashboard/overview.ts` already groups holdings by
  filesystem (`statSync().dev`) and reports free/total per mount, with
  `sharesWith` for mounts of the same filesystem. v2 changes the grouping key
  to the filesystem so a shared drive is ONE bar listing all its mounts. Check
  on Unraid: `/mnt/user` (FUSE over the array) vs `/mnt/cache` vs disk shares.
- **Category sizes**: the database, thumbnails, backups, app files and trash
  paths are known (`DiskHolding.kind`); App storage contents and System data
  already measure some of them. Library media is the libraries' scanned sizes.
  Measuring must stay off the request path
  (`cachedFolderStats`, never a synchronous walk).
- **Growth**: new — a daily measurement table (drive used/free + category
  sizes), written by a scheduled job; a new table goes in `schema.sql`.
- **Cancel**: `POST /api/jobs/:id/cancel` exists (and the duplicate-job one);
  each task type says whether it can be cancelled.
- **Read-only / unavailable**: new checks (a write probe and a timeout on
  statfs) feeding Needs attention.
- **Usage**: the existing activity data (Activity dashboard, chart.js) with
  application and member facets.

## Phones

Phones keep today's compact control-panel navigation: **Home · current
page/menu · Search**. The menu reflects the new groups and the application
pages (Applications › Gallery › Device Sync is a menu entry); desktop tab rows
— the groups' and the workspaces' — stay hidden on phones.

## Addresses

```
/control                                  Dashboard
/control/infrastructure[/tasks|/logs|…]
/control/libraries[/device-sync|/statistics|/tags]
/control/apps                             directory
/control/apps/<app>[/device-sync|/organize|/settings][/<page>][?from=<app>]
/control/security[/members|/groups|…]
/control/settings[/email|/storage|/backups|…]
```

Every v1 address goes into `CONTROL_ALIASES` and keeps resolving; docs links
and bookmarks must not break.

## Implementation notes

- `nav.ts` gains an application registry beside `CONTROL_GROUPS`:
  `{ key, icon, description, status(), tabs: [...], filter }` — `filter` is
  what its Activity, Tasks and Logs links preselect. The workspace tab row is derived from
  it; empty tabs drop out. Applications whose container isn't installed or whose
  section is turned off still appear in the directory, with that status.
- Setup cards need a summary per application (libraries of that type,
  connection state, storage use). Built in phase 2 WITHOUT a new endpoint:
  `features/control/applications.ts` reads what the owning pages already read
  (`/api/config` sections, `/api/apps/admin/status`, the four `?manage=1`
  library lists, `/api/status` sizes), shared for a minute between pages. Status:
  turned off → needs its container (Gallery's face engine is optional) → needs a
  library → ready.
- Search (`search-index.ts`) entries gain the application, so a search for
  "duplicates" shows "Applications › Gallery › Organize".
- `ControlSectionHead` eyebrow: "Applications · Gallery" inside a workspace.
- Server modules don't move: this is a web-app navigation change. Only the
  Logs/Tasks application facet touches the server.

## Phases

1. **Navigation model.** Five groups, Dashboard on the title, Applications
   directory and workspaces hosting the existing pages unchanged, new addresses
   + aliases, search index re-pointed. Activity moves to Infrastructure;
   applications link to Activity, Tasks and Logs with today's filters.
2. **Setup cards and directory status.** *(Built 2026-11-12 on
   `preview/control-panel-v2`.)* Every application opens on Setup — status
   banner, In the menu switch (Appearance's Sections card moved here), libraries,
   connection, access, storage use, each linking to its owner. Family Tree and
   Games became workspaces (Setup only). The directory shows each status; other
   tabs carry a one-line Ready strip linking back to Setup.
3. **Application facet** for Logs, Tasks and Activity on the server; "View
   Gallery logs" links.
4. **Dashboard.** The five sections; drives grouped by filesystem with the
   category breakdown and "Other files"; Needs attention fed by low-space,
   unavailable/read-only, failed-task and security checks; Cancel where
   supported. Then the daily storage measurement and the Growth view.
5. **Docs and rules.** Rewrite the nav.ts header comment, CLAUDE.md's control
   panel paragraph, `docs/UI-CONVENTIONS.md`, the user guides in `docs/users/`
   (25 mention the panel) and their screenshots; update `control-nav.test.ts`
   and `router.test.ts`.

## Open questions

Settled 2026-11-11: Device Sync → Gallery; book categories → one editor reached
from Ebooks and Audiobooks; tags → Shared organization plus a filtered link in
each app (see "Shared controls, several entry points"); Quotes → System Settings
(it is the home widget's content); a page with several entry points has ONE
canonical address and takes `?from=<app>` — the eyebrow, the selected workspace
and the back link follow it (Book categories opened from Audiobooks reads
"Applications · Audiobooks · Organize" and goes back there). Without `?from=`
it falls back to its canonical parent. The tag manager uses the same
parameter alongside its application filter.

Activity → Infrastructure, no Activity tab inside applications; phones keep
today's Home · menu · Search navigation (see "Phones").

None open.
