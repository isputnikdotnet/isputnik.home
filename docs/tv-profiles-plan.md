# Viewing profiles

Status, 2026-11-08:

- **P1 (per-account profiles)**: pushed (home 13e75f59, shipped in 4.73.1; TV 405e2ef, no tag).
  Replaced the same day by the household model below.
- **Household profiles + PIN**: pushed 2026-11-08 (home ccdf46f3, TV 2aa66d8), not yet seen on
  a real TV (the owner asked for no TV testing yet).
- **Own history per profile (P3)**: built 2026-11-09.
- **Released 2026-11-09** together: isputnik.video 0.30.0, home 4.76.0 ("Who's watching"),
  iSputnik TV 0.9.0. With an older engine a profile shares its person's history.

## What the owner asked for

Netflix-style profiles for the household: Kids, Russian, Classic. An admin sets them up on the
video page, where the custom video page is set up, and they're offered on every TV and in the
web app. A TV shows the profiles instead of an account name. Some profiles (Kids) are
protected: switching into Kids is free, switching out needs a PIN.

The first version (P1) made profiles belong to one account and set them up in Profile. The
owner changed that the same day to the household model.

## Decisions

1. **Profiles are the household's.** An admin creates, edits, orders and deletes them on the
   video page: **Customize › Profiles**. Every TV and browser offers the same ones.
2. **A profile is video only**: a name, a colour, which video libraries, its own rows, and
   whether it's restricted. Photos, books, games and the rest of the app stay the account's.
   P1's per-profile sections are gone.
3. **A profile only narrows.** What a session shows is the profile's libraries limited to what
   the signed-in account may see, worked out on every request
   (`visibleVideoLibraryIds()` in `modules/profiles/store.ts`). Nothing is stored as a grant.
4. **Linking is unchanged.** Any account can link a TV, as before; there is no "household
   device". For the family TV, an admin links it once and the profiles do the rest.
5. **The profile sits on the session** (`sessions.profile_id`, migration 91), on a TV or in a
   browser. Home enforces it on every request; a TV restarted in Kids comes back in Kids.
6. **One household PIN** guards leaving restricted profiles. It's optional: without it, anyone
   can switch away and Customize › Profiles warns. It's 4 to 8 digits, costs the admin's
   password to set or remove, and locks for 15 minutes after 5 wrong tries.
7. **Where the lock reaches.**
   - Everywhere: switching away from a restricted profile needs the PIN, and an admin's own
     session in a locked profile can't change profiles, the PIN or a profile's rows.
   - A TV in a locked profile is also refused `/api/profile`, `/api/account` and
     `/api/auth/logout` (`modules/profiles/fence.ts`), and the TV app guards what only it can
     see (choosing another linked person, linking someone, unlinking) with the pad and
     `POST /api/profiles/pin/check`.
   - In a browser the rest of the site stays open: a child with their own browser or tablet
     should have their own member account.
8. **Rows**: a profile's page is its own rows, else the household's rows. A person's own
   "Just me" rows never reach a profile. Rows naming only libraries outside the profile are
   dropped when read.
9. **History per profile (P3).** Each profile has its own Continue watching, watched marks and
   My list, the same whichever account is signed in. A profile starts with an empty history.

## Data

- `viewing_profiles` (household): id, name, avatar (one of eight colours), position,
  restricted, libraries (JSON array or NULL for all), rows (JSON or NULL for the household's),
  created_by, timestamps. Migration 92 rebuilt 4.73.1's per-account table into this,
  keeping every profile and the sessions wearing them.
- `viewing_profile_pin`: one row at most; scrypt hash, failures, locked_until, updated_by.
- `sessions.profile_id` → `viewing_profiles(id) ON DELETE SET NULL`.

## API

| Route | Who | Does |
|---|---|---|
| `GET /api/profiles` | anyone signed in | profiles, `current`, `pinSet`, `locked`, `editable` |
| `POST/PATCH/DELETE /api/profiles[/:id]`, `PUT /api/profiles/order` | admin at a keyboard, not in a locked profile | manage the profiles |
| `PUT/DELETE /api/profiles/pin` | same, plus the admin's password | set, change or remove the PIN |
| `POST /api/profiles/switch` | any session | `{ profileId, pin? }`; 403 `pin_needed`/`pin_wrong` (+`triesLeft`), 429 `pin_locked` |
| `POST /api/profiles/pin/check` | any session | the TV's check before its own-side actions |
| `GET/PUT/DELETE /api/video/home?scope=profile&profile=` | read: anyone; change: admin | a profile's rows |

## Screens

- **Web, video page**: **Watching as** in the toolbar (the account's name and each profile;
  locked profiles marked), shown once the household has profiles. Switching reloads the page.
  Leaving a locked profile asks for the PIN. While a page wears a profile, only an admin (not
  locked in it) gets Customize, and it opens on that profile's rows.
- **Web, Customize**: tabs Just me · Everyone · one per profile · **Profiles** (admins). The
  Profiles tab manages the profiles and the PIN.
- **TV**: Who's watching? at startup (not while locked), profiles on the account screen,
  the profile's name in the top bar, the PIN pad (`PinScreen.kt`) for every way out of a
  locked profile, "Locked" on tiles that need it.

## Own history per profile (P3)

- **Engine** (`isputnik.video`): `X-Isputnik-Profile-Id` gives the identity a `historyId`
  (`profile:<id>`, else the person's id). Progress, watched marks, Continue watching, next up
  and sets read and write by it; the person's own conversions and log lines stay by `id`. No
  migration: `progress.user_id` simply holds the history id. `DELETE
  /api/admin/history/profiles/:id` forgets a deleted profile's history.
- **Home**: the gateway sends the header while a session wears a profile (a client can't send
  it; `X-Isputnik-*` from outside is dropped). My list is `video_profile_my_list` while a
  profile is worn (ON DELETE CASCADE with the profile). Deleting a profile asks the engine to
  forget its history (best effort).
- Screens need no change: the TV and the web ask the same routes as before.

## Open questions

1. **Age ratings.** Kids is a library choice today. A TMDB certification cap would let Kids
   use the ordinary libraries; worth it only if the engine's certifications are reliable.
2. **Avatars.** Colours and a letter for now; pictures would need to ship in the TV app too.
