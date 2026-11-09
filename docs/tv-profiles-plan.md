# Viewing profiles

Status: **P1 built**, 2026-11-08, not released and not yet seen on a real TV. P2 and P3 to come.

### What P1 settled differently from the draft below

- **Avatars are colours** (eight, the same on web and TV) with the name's first letter, not
  pictures the TV would have to ship.
- **Only a linked TV wears a profile** (`POST /api/profiles/switch` refuses a browser), which
  answers open question 3 for now: no profiles in the web app.
- **`own_history` isn't a column yet.** It arrives with P3, along with the PIN table in P2.
- **The section fence is a session guard** (`core/session-guards.ts`, run inside
  `app.authenticate`), added by `modules/profiles/fence.ts`. It matches route prefixes. Book
  routes close only when both book sections are off.
- **Every video access answer goes through `visibleVideoLibraryIds()`**
  (`modules/profiles/store.ts`): the gateway's `X-Isputnik-Libraries`, `video_refs` (My list,
  Collections), and the library list.
- **The TV still shows Video** when a profile leaves Video out (the server refuses its pages).
  The TV only has Video and Games, so such a profile makes little sense there.
- **The TV asks which profile is watching** when it opens, and after choosing another person.
  It doesn't ask when it was left in a restricted profile.

## What the owner asked for

The person who linked a TV can offer several **viewing profiles** on it: Kids, Russian,
Classic and so on. Each profile has its own video home page, set up on the web's video
customisation page. On the TV you pick a profile, not an account name. Some profiles are
**protected**: a child can switch into Kids freely, but switching out of it to an adult
profile needs a PIN.

## What exists today

| Piece | Where | What it does now |
|---|---|---|
| Rows | `modules/library/video/home-layout.ts` | Saved queries in two layers: the household's (`video_home_layouts`, owner `''`) and a person's own copy (`video_home_user_layouts`) |
| My list | `video_my_list` | One per account |
| Progress, watched | the engine (`docs/video-architecture.md`) | Kept for each `X-Isputnik-User-Id` |
| Access | `X-Isputnik-Libraries` (`library/video/index.ts`, gateway `extraHeaders`) | The engine's whole permission model |
| TV sign-in | `core/device-link.ts`, `sessions.kind = 'device'` | One linked session per person on a TV |
| TV picker | `isputnik.tv` `WhoScreen.kt` | Switches between the linked **accounts** |

## Decisions

1. **A profile belongs to one account**, the one that linked the TV. It is a different
   view of that account, not a new person. Household-wide profiles (an admin's, offered
   on every TV) are a later question, not part of this plan.
2. **A profile can only narrow what its account sees, never widen it.** Its libraries
   are a subset of the account's. The server sends that smaller list in
   `X-Isputnik-Libraries`, so a restricted profile is real protection: search, title
   pages, sets and people in Kids can't reach an adult film.
3. **There are two kinds, with one shape:**
   - **Restricted** (Kids): fewer libraries, fewer sections, and leaving it is locked.
   - **Open** (Russian, Classic): only a different home page. No lock, no narrowing
     beyond what the owner picks.
4. **The profile sits on the session, not in a header from the TV.** Switching profiles
   is a server call that writes `sessions.profile_id`. If the TV only sent a header, a
   restricted profile would be a polite request that any client could leave out. With
   the profile on the session, the server enforces it on every request, and a TV
   restarted in Kids comes back in Kids.
5. **The lock is on leaving, not entering.** Going into a restricted profile is always
   free. Leaving it (to another profile, to the account itself, or to another linked
   account on the TV picker) needs the account's PIN, checked on the server. The PIN is
   one per account, set on the web, entered with the D-pad.
6. **Dad and Mom are accounts, not profiles.** Family members already have accounts with
   their own access and progress, and the TV picker shows them. The guide should say
   that profiles are for *views* of one account: a shared Kids, a Russian evening.
7. **Restricted profiles get their own progress, My list and watched marks** (phase P3).
   Otherwise cartoons fill the owner's Continue watching, and Kids sees the owner's
   films there. Open profiles share the account's by default. Whether that should be a
   switch is open question 2.

## Data

New tables go in `schema.sql` only. The new column on `sessions` needs a migration
(project rule: new columns need a migration).

```sql
-- A view of one account for a shared screen (docs/tv-profiles-plan.md). Narrows,
-- never widens: libraries NULL means all of the owner's, else a subset of them,
-- re-checked on every request, because the owner's own access can shrink later.
CREATE TABLE IF NOT EXISTS viewing_profiles (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  avatar      TEXT NOT NULL,             -- one of a fixed set the TV ships with
  position    INTEGER NOT NULL DEFAULT 0,
  restricted  INTEGER NOT NULL DEFAULT 0 CHECK (restricted IN (0, 1)),
  libraries   TEXT,                      -- JSON array of video library ids, or NULL
  sections    TEXT,                      -- JSON array of sections, or NULL = the owner's
  rows        TEXT,                      -- video rows JSON; NULL = the owner's page
  own_history INTEGER NOT NULL DEFAULT 0 CHECK (own_history IN (0, 1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The PIN that lets someone leave a restricted profile. One per account; hashed
-- like a password; attempts capped like MFA.
CREATE TABLE IF NOT EXISTS viewing_profile_pins (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  pin_hash     TEXT NOT NULL,
  failures     INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

- **`sessions.profile_id`** (migration): `REFERENCES viewing_profiles(id) ON DELETE SET
  NULL`. NULL is the account itself. A deleted profile drops its TVs back to the
  account, unless it was restricted (see *Edge cases*).
- **My list per profile** (P3): a new table `video_profile_my_list (profile_id, kind,
  entity_id, added_at)` rather than changing `video_my_list`'s primary key. SQLite would
  have to rebuild the table for that.
- **`npm run db:rows`** after the schema change, and backups carry the new tables like
  any other.

## Server

A new module, `modules/profiles/`, registered as a sibling of `corePlugin`. Core stays
free of product knowledge. It only gets a narrowing hook it calls on a session that has
a profile, the same way it calls other modules' hooks.

| Route | Who | Does |
|---|---|---|
| `GET /api/profiles` | the account | Its profiles, and the session's current one |
| `POST / PATCH / DELETE /api/profiles[/:id]` | the account, browser sessions only | Create, edit, reorder, delete. Refused from a device session, so a TV can't edit its own restrictions |
| `PUT /api/profiles/pin` | browser session + password | Set or change the PIN |
| `POST /api/profiles/switch` | any session of the account | `{ profileId \| null, pin? }`. Leaving a restricted profile needs the PIN; wrong PINs count toward the cap |

**What a profile changes on a request:**

| Place | Change |
|---|---|
| `X-Isputnik-Libraries` (`library/video/index.ts`, and `engine.ts` calls made as the viewer) | The owner's libraries ∩ the profile's |
| Sections (`core/sections.ts` via the hook, and `/api/auth/me`) | The owner's ∩ the profile's. A restricted profile defaults to Video only |
| `/api/video/home` (`home-layout.ts`) | The profile's rows, else the owner's own, else the household's. A profile's row that names a library outside the profile is dropped when read, not saved |
| Identity (`gateway.ts` `identityHeaders`) | Adds `x-isputnik-profile-id` when the profile keeps its own history (P3). The user id stays the account's, so engine logs and access stay simple |
| Control panel and Profile | A session in a restricted profile is refused there, like a device session is today |
| Collections, tags, For you | Already filtered by library access. They read the narrowed list, so check each one goes through it, not `accessibleLibraryIds` directly |

**Engine (P3):** progress and watched marks are keyed by user id plus profile id, with `''`
for the account itself. If the profile header is missing, the engine answers as today, so
an older home keeps working against a newer engine.

## Web

- **Profile › Viewing profiles**: a new tab (`PROFILE_PATHS` / `profileHref()`). It lists
  the account's profiles, with Create, Edit (name, avatar, restricted, libraries,
  sections) and Delete (a `ConfirmDialog` that says linked TVs in it go back to the
  account). Setting the PIN lives here too. It's the person's own, so it goes in Profile,
  not the control panel.
- **Video customisation page**: the existing "Just me / Everyone" choice gains each
  profile: *Whose page: Mine · Kids · Russian · (admins) Everyone*. For a restricted
  profile, the library pickers in its rows only offer its libraries.
- **Search terms** in `features/control/search-index.ts` only if anything joins the
  control panel; the Profile tab is reached from Profile.
- **Guide**: `docs/users/viewing-profiles.md`, listed on the Help page (`check:ui`). It
  says what a profile protects (video and sections on that screen) and what it doesn't
  (a child who knows the account's password, or who signs in on another device).
- **Strings** as `t()` keys in `en` and `ru`, counts with `{ count }`.

## TV (`isputnik.tv`)

- **Picker** (`WhoScreen.kt`): each linked account shows its profiles beside it. Choosing
  one calls `/api/profiles/switch`. While a restricted profile is current, every other
  tile wears a lock, and choosing one asks for the PIN.
- **PIN entry**: a four-digit pad driven by the D-pad, like the existing code entry. Show
  plainly how many tries are left and when the pad unlocks again.
- **Starting up**: the session remembers its profile, so the TV opens where it was left.
  If the TV's profile is restricted, the picker never opens by itself.
- **Theme and name**: the top bar shows the profile's name and avatar instead of the
  account's.
- **Older home**: `/api/profiles` answers 404, and the TV shows accounts as today.
- **Strings**: Android `en` and `ru` resources.

## Edge cases

- **The owner loses access to a library** a profile lists: the intersection drops it on
  the next request. Nothing is stored that could outlive the owner's own access.
- **A restricted profile is deleted** while a TV is in it: that session stays locked to an
  empty Video until someone enters the PIN, rather than quietly becoming the adult
  account. The delete dialog says so.
- **Forgotten PIN**: set a new one from Profile on the web, which needs the password.
- **The account is signed out or revoked**: the profile goes with the session; nothing to
  clean up.
- **Several TVs**: each session keeps its own current profile, so the living room can be in
  Kids while the bedroom isn't.
- **Admins**: an admin's restricted profile is not an admin, because the narrowing hook
  runs before role checks. Test this specifically.

## Phases

| Phase | What | Done when |
|---|---|---|
| **P1** | `viewing_profiles`, `sessions.profile_id`, the switch route (no lock yet), narrowed libraries and sections, profile rows. Profile tab + customisation page. TV picker shows profiles | The owner makes Kids and Russian on the web, picks them on the TV, and each shows its own rows. Kids can't find an adult film by search |
| **P2** | PIN: table, route, attempt cap, TV pad, locked tiles, restricted sessions refused on Profile and the control panel. Guide on Help | A child in Kids can't leave it, or reach another linked account, without the PIN |
| **P3** | Own history: profile header, engine progress and watched by profile, `video_profile_my_list`, profile-aware For you summary | Kids' Continue watching and the owner's never mix |
| **Later** | Age-rating cap from TMDB certifications; profiles narrowing audiobooks and photos; household profiles from an admin; profiles in the web app itself | Each decided on its own |

Tests: server (Vitest, `bootApp()`): narrowing never widens, the admin-in-a-profile case,
the PIN cap, device sessions refused on edit routes. Web (Testing Library): the Profile
tab and the customisation switch. TV: unit tests for the switch and lock state, then the
owner's check on the Fire TV.

## Open questions

1. **Age ratings.** Does the engine keep a reliable certification per title (TMDB
   `release_dates` / content ratings) for both countries the family uses? If so, a
   rating cap would let Kids use the ordinary libraries instead of a separate Kids
   library. Recommended: libraries first (P1), ratings later.
2. **Open profiles' history.** Should Russian and Classic share the account's Continue
   watching (recommended, since they're the same person) or have a switch?
3. **Profiles in the browser.** Worth having (a kids' tablet in the PWA), but each web
   screen would need to show and switch the profile. Recommended: TV only until P3 is
   done.
4. **Household profiles.** One Kids profile an admin sets up for every TV, instead of one
   per account. Wait until someone links a second TV and misses it.
