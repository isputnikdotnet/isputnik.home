# Gallery

A gallery library turns a folder of photos and videos into a browsable timeline —
closer to Google Photos than to a bookshelf.

## How files become items

**One photo, one item.** Unlike audiobooks (a folder is a book), every file
stands on its own. That's what lets the same set of pictures be browsed several
different ways at once.

The scanner reads each file's EXIF data for the date it was taken, the camera,
and the location if the file carries one. When there's no EXIF date — as with
scans or exports — it falls back to the file's modification time.

## The views

Along the top:

| View | What it gives you |
|---|---|
| **Timeline** | Everything newest-first, grouped by date. The default. |
| **Memories** | "This month over the years" — the same date in previous years. |
| **Albums** | Sets you assemble by hand; a photo can be in several. |
| **Slideshows** | Saved sequences with music and transitions, playable or rendered to a movie file. |
| **Folders** | A file-explorer over the actual folder structure on disk. |
| **People** | Faces grouped into people, once face recognition has run. |

They're all views of the same photos — nothing is copied or moved between them.

## How the grid looks

**View**, next to Filter and Sort, sets two things and remembers them for next
time:

- **Tile size** — Small, Medium or Large. Small fits far more on screen for
  hunting through a big year; Large is for actually looking at the photos. It
  applies to the timeline and to an open folder.
- **Dates** — *Group by day* is the default: a heading over each day, with the
  checkbox that takes the whole day at once. *One continuous grid* drops the
  headings and runs every photo together as a single wall, which reads better
  when you're scrolling for a picture rather than for a date. Selecting still
  works there — use **Select** in the toolbar, since there are no day headers to
  tick.

## Viewing

Click a photo to open the viewer. From there: pan and zoom, step through with
the arrow keys, see details in the info panel, rotate, like, share, or add
to an album or slideshow. Videos play inline; a format the browser can't decode
is offered as a download, and the server can transcode a web-playable copy.

Rotation works for videos too — a clip filmed sideways turns upright in the
viewer and in its thumbnails, and keeps playing while you turn it.

## Working with several at once

The **Select** button in the header turns the grid into a picker — click photos
to tick them, or use a date header's checkbox to take a whole day. A toolbar of
icons appears with what you can do to the selection: like it, add it to an
album, slideshow or collection, set the date taken, set the location, share it,
or move it to the Recycle Bin. Hover an icon to see what it does.

Date and location are two separate buttons, each with its own window — fix
whichever is wrong and leave the other alone. Both are for what the camera got
wrong or never knew, and what you set is kept as yours, so a later scan won't
overwrite it.

**Set date taken** works two ways. *Set one date* applies that exact date and
time to everything selected, so those photos sit together in the timeline —
right for a batch of scans that share one occasion. *Shift by an offset* moves
each photo from its own date by the same amount, in either direction, which
keeps the order and spacing the camera recorded — the fix for a camera left on
the wrong timezone or a clock that was hours out. Photos with no date at all
can't be shifted, and the message afterwards says how many that was.

**Set location** drops one pin for the whole selection, and they join the Map
view. Rather than hunting across a world map, type a place, address or postcode
into the search box and pick from the results — the map jumps there with the pin
already placed. Coordinates work too: paste `53.90064, 27.55910` and it goes
straight there. Clicking or dragging on the map still works for fine-tuning.

Plus Codes work as well, which is what "Copy address" in Google Maps usually
gives you for a spot with no street number: paste
`8MW8+4JV, Norman Manley Blvd, Negril, Jamaica` and the pin lands on the code,
not on the town. Those short codes only mean something next to a place name, so
keep whatever followed the code when you paste. A long code that starts with the
region — `77C38MW8+4JV` — stands on its own and needs no lookup at all.

The search asks OpenStreetMap's public lookup service, so it needs the server to
have internet access — the same place the map's tiles come from. Plus Codes are
worked out on the server itself, though a short one still needs that lookup for
the place beside it. Without any internet, dropping the pin by hand still works.

## Uploading

If the library allows uploads, the upload button takes files straight in. They
land in dated subfolders (`2024/2024-06-15`) based on when each was taken, so
uploads blend into a folder structure rather than piling up at the top.

## Face recognition

**Off by default, and entirely local** — the models ship with the app, nothing is
sent anywhere. An admin turns it on per library in the library's settings.

Once enabled, a background job finds faces and groups them into people. You then
name the ones you care about; naming is what makes a group stick. The **People**
view lists them, and a person's page shows every photo they appear in.

This is also what connects to the [family tree](family-tree.md): link a family
member to a face group and their profile fills with photos automatically.

## Housekeeping

Re-scan after copying files in. Deleting a photo moves it to the **Recycle Bin**
first, so it can be restored until the bin is emptied.

**Locking a folder.** An admin browsing the **Folders** view (with a single
library in scope) can open a folder and press **Lock folder**: from then on
nothing in it — or in any of its subfolders — can be deleted from the app, by
anyone, until it's unlocked from the same place. Locked folders wear a small
padlock on their tile. The lock only stops deleting: viewing, uploading into the
folder, editing details and rescanning all carry on as normal, and Duplicate
cleanup treats the locked copies as the ones to keep. It's the right guardrail
for the folders you'd never want a careless selection or cleanup to touch.

If the same picture has been imported more than once, **Duplicate cleanup** in the
control panel finds it — identical files, near-identical ones, and whole folders
that duplicate each other — and moves what you agree to remove to the Recycle Bin.
It has [its own guide](duplicate-cleanup.md).

Your originals are never modified — rotating a photo or video in the app changes
the generated preview, not the file on disk. (This is why a downloaded original
still has its old orientation.)
