# Gallery lightbox: the side panel

The lightbox (`features/gallery/GalleryLightbox.tsx`) shows one photo; its side
panel (`features/gallery/GalleryLightboxPanel.tsx`) is where the family writes on
it. This note records the shape agreed on 2026-09-10 and why.

Design mock (private link, kept for reference):
https://claude.ai/code/artifact/56bf3a86-5051-4a22-824d-726d34fdd90e

## Why it changed

The old panel was one definition list: name, description, voice notes, date,
place, type, dimensions, duration, size, camera, location map, people, folder,
library, tags, then the notes thread. Three things on it were called "notes"
in one way or another — the description Review mode writes into ("Anything you
remember?"), the voice notes beside it, and the Notes thread at the bottom — and
the file facts sat between the human ones.

## Three tabs

| Tab | Holds | Who it is for |
| --- | --- | --- |
| **Details** | file name (read-only), date with its exactness pill, place, People, Tags, Description with its *Noted by* line, Recordings, Notes | everyone |
| **Map** | the pin (mini map), coordinates, place text, "Mark where it was taken" / "Move the pin", the search + picker while editing | whoever places photos |
| **File** | name, type, dimensions, duration, size, camera, added, folder link, library; Rotate left/right and Replace file | the person tidying the archive |

The tab survives moving to the next photo, so a trip can be browsed on Map.

## Decisions

- **Date sits on Details, not File.** It is the most-edited fact in a family
  archive and Review mode writes it. The pill shows the precision when it is
  coarser than a time ("Year", "Decade"); "about" is already in the text.
- **The name is not editable.** It is the file on disk. It heads Details as a
  line and appears again on File.
- **"Recordings", not "Voice notes".** The word "notes" now appears once on
  the panel, on the thread. Recordings are the spoken form of the description
  and sit under it. (The `gallery:voiceNotes.*` key names are unchanged.)
- **Notes is drawn as a thread.** Names, times, a Post box, the speech-bubble
  icon, and no Edit — no note is edited in place. Its placeholder on a photo
  says "Say something about this photo" (`NotesSection`'s `placeholder` prop)
  so it does not read as a second description.
- **Tags and People are chips with a round +.** Removing is the × on the chip;
  adding opens the small inline form. Both save through the same PATCH as
  before (`edit.ts`), with tags merged into the existing list.
- **The panel owns its edits.** State for field editing, people, voice notes
  and the tab lives in the panel; the lightbox learns of changes through
  `onChanged` and only lends rotate/replace (the stage must react to a
  rotation).
- **The bar carries five actions; the rest fold under ⋮.** Favorite, Add to
  album, Download, Send to, Details are the bar. Add to collection, rotate,
  replace and delete are the menu — delete was one slip from Download
  otherwise. Mobile keeps its row cap and folds whatever does not fit.
- **The bar shows "3 / 12".** The photo's place in the set, then its name.
- **Phone.** Below 740px the same panel is a sheet from the bottom over the
  photo (`gallery.css`, the `@media (max-width: 740px)` block by the panel
  rules), the same three tabs, nothing mobile-only.

## Phase two — recording and playback

Built 2026-09-10 from a second mock (private link, kept for reference):
https://claude.ai/code/artifact/2006e633-3470-4713-93cc-a598813d8971

**Recording** is a dialog, `RecordVoiceNoteModal.tsx`, on the shared card
Modal, with the photo's thumbnail as its icon. One big button carries three
states — Record, Stop (pulsing), then the take — and the waveform behind it is
drawn from the microphone through an `AnalyserNode`, one bar per 60 ms, so
silence looks like silence. Nothing is uploaded on Stop: the dialog switches to
listen-back (a seek bar over the same trace) with **Record again**, **Discard**,
Cancel and **Save**. Cancel, the close cross, Discard and Record again all ask
first once a take exists; while recording or saving, dismissal is blocked
(`busy`). The microphone is asked for on the first press, not when the dialog
opens; a refusal shows in the dialog with the button ready to try again. The
five-minute cap is printed beside the clock and still stops the recorder.

**Playback** in `VoiceNotes.tsx` is a plain line per recording — play button,
who, length · date, a ⋮ menu with Download and Remove; no card — and **one
player** above the rows, which is the card. Pressing a row loads it into that
player (one `<audio>`, so two never play at once); pressing the current row
pauses, and its name takes the accent. The player is the dialog's picture: the
wave strip of what is playing (clicking it seeks), the seek control under it,
then play/pause, who and when, and the time. Removing the recording that is
playing takes the player away with it. `VoiceNotes` draws the section heading
with the Record button itself (`heading` prop); Review mode passes
`heading={false}` and `large`, keeps its "Or just say it" hint, and gets the
Record chip under the rows.

**The wave is decoded, not stored.** `voice-wave.ts` fetches the recording once
it goes into the player and reads its peaks with `decodeAudioData`; a format
the browser cannot decode (it could not play it either) draws a flat strip and
the seek control still works. Nothing about peaks is kept on the server. The
dialog's strip during recording comes from the microphone's analyser instead.
