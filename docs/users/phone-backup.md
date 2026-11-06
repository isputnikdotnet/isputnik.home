# Backing up your phone

Your phone can copy every new photo and video into **your own private library** on iSputnik,
at full quality, without you doing anything — while it is at home on the Wi-Fi. It uses the
**PhotoSync** app (Android and iPhone), which talks to iSputnik directly: nothing goes through
anyone's cloud. A photo you delete on the phone stays at home.

What you need:

- **My library** turned on in your profile (below). Only you can open it — not the others in
  your household, and not the administrators.
- **PhotoSync** from the Play Store or the App Store. It is a paid app; on an iPhone, automatic
  backups need PhotoSync's Premium plan, and keeping HEIC photos as they are needs at least Pro
  (the free version turns them into JPEGs).
- The phone on a network your administrator listed for phone backups: your home Wi-Fi, or a
  VPN into the house. Backups never go over the open internet.

> Your personal library is **one copy** of your photos, not a backup. If the server's disks
> fail, it goes with them. Keep another copy somewhere else.

## Turning on My library

1. Open **Profile › My library**.
2. Press **Turn on my library**. A library named after you is made, empty.

If the tab says personal libraries are unavailable, your administrator hasn't allowed them yet
(or not for you) — ask them. More about the library itself is in
[Your account](your-account.md#my-library).

## Adding a phone

1. On **Profile › My library**, under **Phones**, press **Add a phone**.
2. Give it a name you will recognise ("Anna's iPhone"). Its photos are filed in a folder of
   that name.
3. The next screen shows what to type into PhotoSync: **server**, **port**, **path** (`/dav/`),
   **SSL**, your **user name** and a **password** made for this phone alone. Each has a copy
   button.

**The password is shown only this once.** Leave the screen open until PhotoSync is set up. If
you lose it, revoke the phone and add it again — it costs nothing.

If the screen says the server address isn't set yet, your administrator still has to fill it
in; keep the password and ask them for the address.

If **Phones** says phone sync is unavailable, no network has been listed for phone backups yet.

## Setting up PhotoSync

PhotoSync calls iSputnik a **WebDAV** target. The menu names below are PhotoSync's and can move
a little between versions.

### On Android

1. Open PhotoSync, then **Settings › Configure › WebDAV**, and add a new target.
2. Type in what the Add a phone screen showed:
   - **Server**: the address, without `http://` (for example `192.168.2.10`)
   - **Port**: for example `4000`
   - **Path**: `/dav/`
   - **SSL**: off, unless the screen said on
   - **Login / user name**: your user name (your sign-in email)
   - **Password**: the phone's password
3. Save. To try it, select a few photos, press the red transfer button and choose the WebDAV
   target. They should appear in your library within moments.

### On iPhone

1. Open PhotoSync, then **Settings › Configure › WebDAV**, and add a new target.
2. Type in the same details as above: server, port, path `/dav/`, SSL, user name, password.
3. Save, then send a few photos by hand to try it.

The iPhone steps follow PhotoSync's own instructions and have not been tried on an iPhone
yet; if something looks different on your phone, tell your administrator.

## Backing up automatically

PhotoSync's **Autotransfer** sends new photos on its own. Point it at the WebDAV target, choose
the albums to back up (usually Camera — and Screenshots or WhatsApp if you want those), and
**restrict it to Wi-Fi**, so it never tries from mobile data, where the server can't be reached
anyway.

PhotoSync remembers what it already sent and asks the server before sending, so Autotransfer
only ever sends new photos.

### On Android

In **Settings › Autotransfer**, choose the WebDAV target and set the trigger to **Instant**: a
new photo goes a minute or two after you take it, whenever the phone is on the home Wi-Fi.

**Samsung phones** (and some others, such as Xiaomi) hold background apps back to save battery,
and a photo can then wait until you next open PhotoSync. To stop that:

1. **Settings › Apps › PhotoSync › Battery**: choose **Unrestricted**.
2. **Settings › Battery › Background usage limits**: make sure PhotoSync is **not** in
   *Sleeping apps* or *Deep sleeping apps*.

### On iPhone

An iPhone does not let any app run whenever it likes, so Autotransfer only starts when
something wakes it. PhotoSync offers three ways:

- **When charging** — iOS picks the moment and may put it off.
- **Arriving at a location** — needs location access set to *Always*, and fires when you
  arrive home from at least 200 m away.
- **A Shortcuts automation** — for example *when connected to the home Wi-Fi*, or *every night
  at 02:00 while charging*, running PhotoSync's Autotransfer action.

Each background run gets only about **three minutes**, so it carries the day's handful of new
photos, not a whole camera roll or a long video. And if you swipe PhotoSync away in the app
switcher, iOS stops waking it — leave it there.

### The first backup

The first backup sends everything, which can be thousands of photos. Do it **with PhotoSync
open**: plug the phone in, keep it on the home Wi-Fi, open PhotoSync and transfer all the
albums by hand, and leave it overnight with the screen on. On an iPhone this is the only way it
finishes; on Android it is simply quicker. After that, Autotransfer keeps up.

If the transfer stops part-way, start it again: nothing half-sent is ever kept, and what
arrived is not stored twice.

## Is it working?

Each phone on **Profile › My library › Phones** shows:

- **Last contact** — when the phone last spoke to the server, and when the last file arrived.
- **Last 24 hours** and **In all** — how many files it sent, and how big.
- **A problem**, if there was one, and when. It shows as a notice until the phone backs up
  again; after that it stays as a line saying it was earlier.
- **No contact for N days**, when the phone hasn't been in touch for a week. Open PhotoSync on
  it: it may be off the home Wi-Fi, swiped away (iPhone), or held back by battery settings
  (Android, see above).
- **Your library is 90% full**, when your library is close to the size limit your administrator
  set. Phones are refused once it is full, so make room before then.

The problems you may see:

| Problem | What to do |
| --- | --- |
| **Refused: not from a phone-sync network** (with an address) | The phone tried from somewhere not listed — mobile data, a friend's Wi-Fi, a VPN the administrator hasn't added. Back up at home, or ask the administrator to list your VPN. |
| **File type not allowed: .dng** | RAW photos (and other types the library doesn't take) are turned away. Switch RAW off in the camera, or leave those out of Autotransfer. The other photos still go. |
| **Your library has reached its size limit** | Your administrator set a limit. Move photos into a family library, delete some, or ask for more room. |
| **The server's disk is full** | Tell your administrator. Nothing is lost; the phone sends again once there is room. |
| **An upload stopped part-way** / **arrived damaged** | Usually the Wi-Fi dropped. PhotoSync sends the photo again next time; nothing broken is kept. |

## Good to know

- **Sending an album again re-sends the bytes but stores nothing twice.** A manual transfer of
  an album you already backed up makes PhotoSync send every photo again — it takes as long as
  the first time — but the server sees they are already there and keeps none of them twice.
- **Where the photos go.** Each phone has a folder of its own in your library, named after it,
  and inside it a folder per day the photo was taken (`Anna's iPhone/2026/2026-11-05`). The
  date comes from the photo itself, or its name, or what the phone says.
- **Deleting on the phone never deletes at home.** Free up the phone as you like.
- **Live Photos** arrive as two files, a photo and a short video with the same name, and
  become **one photo** with a *LIVE* mark. To see the motion, open the photo and press
  **LIVE**, hold the photo on a phone, or hover it with the mouse on a computer. Keep both
  files together: the pair is recognised by name. (This works in every photo library, not only
  your own.)
- **A lost or replaced phone**: **Revoke** it on the Phones list. It stops at once, and what it
  sent stays. A new phone is added as a new phone, with its own folder.
- **Away from home**, backups only work through a VPN into the house (UniFi, WireGuard,
  Tailscale and the like), and only once your administrator has added the VPN's addresses to
  the phone-sync networks. Turn the VPN on, then send from PhotoSync. If Autotransfer is set to
  *Wi-Fi only*, it waits until you are home, so send by hand when you want it now. Without the
  VPN the phone is refused (the Phones list says from which address) and simply catches up when
  you are home again.

## For the administrator

Nothing works until you set it up, on purpose:

1. **Library › Storage › Personal libraries**: allow personal libraries, choose where they are
   made, who may have one and any size limit — see [Storage](storage.md#personal-libraries).
2. **Security › Phone sync**: list the networks phones may back up from (**Copy trusted
   networks** is a starting point), and fill in **Address phones use** — the address phones on
   that network reach the server at, such as `http://192.168.2.10:4000`. The list is separate
   from Trusted networks, so adding a VPN range for phones does not relax sign-in for it. See
   [The control panel](control-panel.md).
3. For backups away from home, add the **VPN's own range** (the addresses phones get on the VPN,
   not your home network's) with its size: `192.168.12.0/24`, not `192.168.12.0`, which is one
   address. On a UniFi gateway it is under *UniFi Network › Settings › VPN › VPN Server*; for
   WireGuard it is often `10.6.0.0/24`, for Tailscale `100.64.0.0/10`. The VPN must route to
   the server without hiding the phone's address (UniFi's VPN server does). Never publish
   `/dav` through a public proxy or tunnel.

What you see of someone's backups is their phones and the size of their library, never what is
in it:

- **Security › Phone sync** lists every member's phones on one page: whose, last contact, the
  address and network it last came from, and what is wrong now — refused, no contact for a
  week, or a library nearly full. A phone refused from an address on no list gets an
  **Add 192.168.12.0/24** button (the /24 it came from), and **See in Logs** opens that phone's
  history.
- **A member's page › Account** has a *Personal library and phones* card: the library's size
  (with a warning near the limit), each phone with when it was added and last made contact, and
  a problem when it is about the phone or the server (refused from an unlisted network, disk
  full, size limit reached, no contact for a week). You can **Revoke** a phone there.
- **Library › Storage › Personal libraries** totals them: how many there are, how much they
  hold, and how many phones back up into each.
- **Overview › Logs**, filtered to the *photo_sync* event, is the history: phones added and
  revoked, a phone's first contact and each move to another network (home Wi-Fi to the VPN),
  refusals (an unlisted network, a revoked or unknown password), a full disk or library, and
  "backing up again" afterwards — at most once an hour per phone and problem, never a file
  name.
