# Gallery

A gallery library turns a folder of photos and videos into a browsable timeline —
closer to Google Photos than to a bookshelf.

![A gallery library after scanning](images/32-gallery.png)

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

The screenshot above shows the timeline grouping by date, with a Memories tile
on top, because the sample photos were deliberately dated across several months.

## Viewing

Click a photo to open the viewer. From there: pan and zoom, step through with
the arrow keys, see details in the info panel, rotate, favourite, share, or add
to an album or slideshow. Videos play inline; a format the browser can't decode
is offered as a download, and the server can transcode a web-playable copy.

## Working with several at once

The **Select** button in the header turns the grid into a picker — click photos
to tick them, or use a date header's checkbox to take a whole day. A toolbar of
icons appears with what you can do to the selection: favourite it, add it to an
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

The search asks OpenStreetMap's public lookup service, so it needs the server to
have internet access — the same place the map's tiles come from. Without it,
dropping the pin by hand still works.

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

If the same picture has been imported more than once, **Duplicate photos** in the
control panel finds the copies and lets you choose which ones stay — merging the
tags, albums and tagged people of the ones you remove onto a copy that survives.
See [the control panel guide](control-panel.md).

Your originals are never modified — rotating a photo in the app changes the
generated preview, not the file on disk.
