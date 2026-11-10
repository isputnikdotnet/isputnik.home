# iSputnik TV in the stores — plan (draft for review)

Written 2026-11-08. Follows `tv-app-plan.md` (the app itself, T0–T4 as built) and
`tv-profiles-plan.md`. The app repo is `isputnik.tv`; home is this repo; the engine is
`isputnik.video`.

## In one sentence

Put the TV app on the Amazon Appstore and Google Play, in that order, after standing up
a public demo server on the owner's Unraid that store reviewers can sign in to.

## Why a demo server comes first

Both stores install the app and run it by hand. Google's TV review (`TV-G5`) and Amazon's
"testing instructions" field both require working sign-in details when an app needs a
sign-in. Ours needs a server, and signing in is **Link a device**: the TV shows a code, a
signed-in person approves it with their password. A reviewer has no iSputnik and no
household phone, so they need:

1. a server on the internet they can type into **Connect**;
2. an account on it whose password they hold;
3. permission for the link request to come from *their* network, not the house.

Home already has every piece: the demo content (`D:/Demo/site`, built for the public
guides, public-domain films and shows, Commons photos), the security policy switch
`deviceLinkScope = "any"` (`core/security.ts` → `deviceLinkAllowedFrom`), and the link
page at `/link`, where a signed-in person types the code and their password. Nothing new
has to be built in the app for a reviewer; the demo just has to exist where they can reach
it.

Staying with Android: Apple TV and Roku were looked at on 2026-11-08 and set aside. The
way to reach them later is a Jellyfin-compatible API on the engine, not another native
app; tablets are served by the web app, not by this one.

## Decisions

- **Demo lives on Unraid**, as a second `isputnik` container pair (home + video) beside the
  family's, with its own appdata, media, secrets and hostname. The family instance never
  takes reviewer traffic.
- **The demo resets itself** on a schedule from a snapshot. Reviewers link TVs, play films
  and change profiles; none of it should accumulate or leak into the next review.
- **One store build, two stores.** A `store` product flavor without the GitHub updater;
  the same `applicationId` and the same signing key as the GitHub releases, so a TV
  installed from GitHub can later update from a store. The `github` flavor stays: it is
  the answer for Android TVs without Play and for Fire TVs that sideload.
- **TV only.** The store flavor declares `android.software.leanback` as *required*, so
  neither store offers it to phones or tablets and Google does not review it as a
  large-screen app. The web app is the tablet answer.
- **Amazon first.** Free account, APK accepted, no closed-testing gate; it exercises the
  demo server and the review notes with the least ceremony. Google second, since it may
  need 12 testers for 14 days first.
- **A privacy policy page** is needed by both stores. The app stores a session token on
  the TV, talks only to the server the person typed in, and sends nothing to the
  developer; the store flavor does not even call GitHub. The page says exactly that.

## D — the demo server

### D1. Content and database, built from `D:/Demo/site`

- The demo appdata is a copy of `D:/Demo/site/data` (db, backups, video catalog) and
  `D:/Demo/site/thumbnails`; the media is `D:/Demo/site/media` (Audiobooks, Ebooks,
  Photos, PhotoGallery1, iSputnik, Video). All of it was assembled for the public guides,
  so its rights are already settled (`CREDITS.md`; US public domain only, no Blu-ray rips).
- Stored paths in the database are Windows paths (`libraries.source_path`,
  `storage_roots`, the `app_settings` roots, `jobs.payload`, `activity_logs.detail`,
  engine `libraries`). They are rewritten to the container paths the same way the demo
  was first made (`D:/Demo/README.md` → "The demo site"), scripted so it can be re-run
  when the demo content changes.
- Accounts: the owner keeps the admin (with MFA). Reviewer accounts are **members**, one
  per store (`amazon-review@…`, `play-review@…`) with long unique passwords, so each can
  be revoked on its own and a store's sign-ins are told apart in the log. The
  `test@test.com / test1234` pair that the guides use is not on the public demo.
- The reviewer member sees the video libraries and the photo library, has a Kids profile
  and the household PIN to try, and no upload, scan, Inbox or Device Sync permission.

**D1 as built (2026-11-09).** `D:/Demo/scripts/unraid-demo.mjs` packs the demo site
into `\\192.168.2.83\data\isputnik-demo` (`/mnt/user/data/isputnik-demo`): `media/`
(4.0 GB; `media/Video` is the engine's `/media`), `seed/home` and `seed/video` (fresh
`/config` folders) and `scripts/demo.sh` (`install | snapshot | reset`, D3). It snapshots
both databases with SQLite's backup (the demo's WAL is never half-copied), rewrites the
drive paths in libraries, the storage root, four settings, activity lines and a job
error, gives both accounts random passwords (the Demo Admin becomes
`admin@demo.isputnik.example`; passwords only in `~/.isputnik-demo/accounts.txt` on the
dev PC), drops sessions, tokens, passkeys, sign-in history and share links, sets
`deviceLinkScope = any`, and stops if a drive path, `test@test.com` or the house's
coordinates survive. Two things the plan had not foreseen: the demo copy still held the
**house's real coordinates** as `home_location` and the saved "Home" place (moved to the
Wisconsin State Capitol), and the owner's **OpenRouteService key** (dropped). The engine
catalog needed nothing: its folders are relative and it held no progress. The schema is
left at the demo's version (90); the published image migrates it on first boot. It has
not booted on Linux yet — no Docker on the dev PC — so the first install is that test.
Reviewer members are made in the app after the first boot, not by script; the setup
steps are in `D:/Demo/README.md` → "The public demo on Unraid".

### D2. Containers and network on Unraid

- Two containers from the published images and the same CA templates, named apart
  (`isputnik-demo`, `isputnik-video-demo`), on `br0` with their own fixed addresses like
  the family's, with their own `GATEWAY_SECRET` pair and their own appdata and media
  shares. No faces container; no games container unless the TV app's Games feature is
  wanted in the demo (it hides when the server has no games).
- A public hostname on the owner's existing edge (the one that serves
  `hub.isputnik.com`), with HTTPS, so the TV app's Connect takes it without the plain-http
  warning. `TRUST_PROXY` names the proxy, as `docs/hosting.md` says, or Link a device
  refuses every request with reason `proxy`.
- Security policy on the demo: `deviceLinkScope = any`; "MFA outside trusted networks"
  off for members (the admin keeps MFA on their own account); sign-in alerts and
  notification mail off, since there is no mail. Rate limits, lockouts and CSRF stay as
  they are.

### D3. Reset on a schedule

- A snapshot of the demo appdata (home db + video catalog + thumbnails) is kept beside
  it. An Unraid User Script stops both containers nightly, restores the snapshot, and
  starts them. That clears linked devices, progress, profile changes, review-time
  uploads if any slipped through, and failed sign-in counters.
- Home's own backup is **not** the mechanism: it is for a family's data and would carry
  the reviewers' sessions along. Media is not snapshotted; it does not change.
- The snapshot is rebuilt from `D:/Demo/site` when the demo content or the schema moves
  (a new image upgrades the db on first boot; take the snapshot after that boot, not
  before, or every night re-runs the migrations).

### D4. Check from outside

- From a phone on cellular, not the house Wi-Fi: open the hostname, sign in as a reviewer
  member, open `/link`.
- On the Fire TV, with the house Wi-Fi: **Connect** to the hostname, read the code, type
  it on the phone with the reviewer's password. Browse, play a film, an episode, Skip
  intro, switch to the Kids profile with the PIN, unlink from the TV's menu.
- Repeat the link once more with the TV on a hotspot, so the request itself comes from
  outside and `deviceLinkScope` is proven, not assumed.
- Write the reviewer steps down as they were actually done. That text is the store
  "testing instructions" and the Play reviewer note, word for word.

## A — Amazon Appstore (Fire TV)

### A1. The `store` flavor in `isputnik.tv`

- `productFlavors { github; store }` in `app/build.gradle.kts`, dimension `channel`,
  same `applicationId`. `store` has no `Updates.kt`, no `REQUEST_INSTALL_PACKAGES`, no
  `FileProvider`, no `RELEASES_URL`; its manifest sets `leanback` *required* and keeps
  `touchscreen` not required. Store policy: an app may not update itself except through
  the store, and the permission alone draws the question.
- The banner becomes 320×180 px in `drawable-xhdpi` (today it is 640×360 there), the
  Android TV spec size. Both flavors use it.
- `release.yml` builds `assembleGithubRelease` (the GitHub APK, as today),
  `assembleStoreRelease` (Amazon's APK) and `bundleStoreRelease` (Google's AAB), all
  signed with the real key, and keeps the store files as workflow artifacts. They are
  uploaded to the stores by hand; they are not attached to the GitHub Release.
- Version codes stay as they are (`major*10000 + minor*100 + patch`); both flavors share
  them so a TV can move between channels.

### A2. Fire TV checks

- Amazon's requirements the app already meets: no Google Play Services (ZXing core,
  Media3, OkHttp, Coil are pure JVM), D-pad navigation, Back exits, `touchscreen` not
  required, works on Fire OS 7 (Android 9) and up — `minSdk 26` covers it.
- Device targeting: Fire TV only (every Fire tablet unticked). Vega OS devices cannot run
  it and will not be offered it; the guide already says so.
- Run Amazon's App Testing Service on the store APK before submitting; it reports the
  Fire TV checks that would fail review.
- Choose **keep my own signature** on upload. Otherwise Amazon re-signs with its key and a
  GitHub-installed TV can never update from the store.

### A3. Listing

- A developer account (free; individual or company, the owner's call). Privacy policy
  URL. Export compliance: HTTPS only, standard exemption.
- Assets in Amazon's sizes: 512×512 icon, 1280×720 Fire TV icon, three to ten 1920×1080
  screenshots of real screens (home rows, a show, the player, the profile picker), an
  optional 1920×1080 background. Screenshots come from the Fire TV over `adb exec-out
  screencap`, from the demo server so nothing from the family appears.
- Description in English and Russian, saying plainly that the app needs an iSputnik
  server at home and linking the guide. Content rating questionnaire. Testing
  instructions from D4 with the Amazon reviewer's credentials.

### A4. Submit and follow

- Submit; answer review questions. On approval, update `docs/users/tv-app.md`
  (Installing: the store first, GitHub as the other way; Updates: from the store) and
  `tv-app-plan.md` → "Installing and updating".
- Revoke the Amazon reviewer's sessions after approval (the nightly reset does it anyway).

## G — Google Play (Android TV, Google TV)

### G1. The account, a decision before anything else

- Registration is a one-time fee with identity verification. Google shows the
  developer's name, email and country on every listing.
- **Personal account**: must run a closed test with at least 12 testers opted in for 14
  continuous days before the first production release. The family and friends on their
  own homes, plus the demo, are enough people, but the clock only starts once they are
  opted in, and pausing the track resets it.
- **Organization account**: no closed-testing gate, needs a D-U-N-S number, and the
  listing shows an address and phone.
- The owner decides which. The rest of G assumes personal, the slower path.

### G2. Play App Signing with the existing key

- New apps must join Play App Signing. At the first upload choose **use an existing
  key** and upload the current release key with Google's PEPK tool. Then Play's APKs
  carry the same certificate as the GitHub ones (the SHA-256 pinned in `release.yml`),
  and a TV installed from GitHub updates from Play without uninstalling.
- This choice cannot be changed later. Letting Play generate a key would split the
  installed base for good.

### G3. Listing and the TV form factor

- Upload the store AAB. Store listing: at least one 16:9 TV screenshot at 1920×1080, the
  1280×720 TV banner, 512×512 icon, 1024×500 feature graphic, "Android TV" in the
  description, the server requirement stated, privacy policy URL, Data safety form (no
  data collected or shared), content rating, target audience not children (the Kids
  profile is a household filter, not a "designed for families" claim).
- Setup → Advanced settings → Form factors → **Android TV**, agree to the TV review.
  Reviewer note: the D4 steps and the Play reviewer's credentials.
- TV quality floor, already met: `minSdk 26` (≤ 31), `targetSdk 35` (≥ 34),
  `LEANBACK_LAUNCHER`, D-pad throughout, Back to home, landscape only, no native code so
  the August 2026 64-bit and 16 KB rules are met by nature. Keep it that way: an ffmpeg
  decoder extension in Media3 would bring native libraries and those rules with it.

### G4. Tracks

- Closed testing first with the family as testers (also the personal account's gate),
  on their own homes; the demo server is for Google's reviewers. Then production. The
  Android TV review runs against the production release; its verdict shows under
  Pricing and distribution → Android TV.
- On approval, the same doc updates as A4, and the Play reviewer's account is revoked.

## Home server changes, all told

- None required for the stores. The demo uses settings that exist (`deviceLinkScope`,
  MFA policy, member permissions) and the published images.
- Nice to have, not gating: a per-account "cannot approve devices from outside" would let
  the demo keep `deviceLinkScope = any` for reviewers while the admin stays house-only.
  Today the scope is one switch for the whole server.

## Open questions

- The demo's hostname, and whether it is under the owner's existing domain.
- Personal or organization Google account (G1).
- Should the demo include the games container, so the Games row is reviewable?
- Reset cadence: nightly is proposed; a reset right after each review is the minimum.
- Where the privacy policy page lives: a page on the demo host, or a GitHub Pages site
  from the `isputnik.tv` repo. Both stores want one stable URL.
- Whether the GitHub APK keeps the in-app updater once the stores exist. Proposed: yes,
  it is the only channel for an Android TV without Play.

## Order of work

1. D1–D3: demo appdata from `D:/Demo/site`, two containers on Unraid, public hostname,
   policy, reset script. D4 proves it from outside and yields the reviewer text.
2. A1: `store` flavor, banner size, workflow outputs. A2–A4: Amazon account, checks,
   assets, submit.
3. G1 decision, then G2–G4.
4. Guides and this plan's "as built" notes, as with the TV plan.
