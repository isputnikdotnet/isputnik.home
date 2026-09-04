// The in-app changelog: what shipped in every release, newest first. This is
// product copy, not platform infrastructure, which is why it does not live in
// core/ alongside the route that serves it.
//
// It is also large — a few hundred KB across 200-odd releases — and it used to
// be an inline literal inside the /api/about handler, so every visit to the
// About page downloaded the project's entire history to render the ten entries
// that fit on screen. /api/about now sends RECENT_VERSION_COUNT of these and the
// total; the rest are paged in from /api/about/changelog on demand.

export interface VersionUpdate {
  version: string;
  label: string;
  changes: string[];
}

/** How many releases /api/about sends inline — roughly one screen of timeline. */
export const RECENT_VERSION_COUNT = 10;

export const VERSION_UPDATES: VersionUpdate[] = [
  {
    version: "3.59.0",
    label: "Housekeeping you don't have to think about",
    changes: [
      "A new monthly task tidies the folder your cover art lives in. Deleting things leaves empty folders behind — a photo here, a book there — and they add up quietly: one real library had 531 of them. The task sweeps them away once a month, and while it is in there it counts the cover files nothing in your catalogue points at any more and tells you the number. It sits with the others under Maintenance → Scheduled jobs, where you can change when it runs, run it now, or turn it off.",
      "It counts those leftover files rather than deleting them, and that is deliberate. Some cover art is made rather than recorded — the large version of a book cover, the web-friendly copy of a video — so a task that removed everything the catalogue did not mention by name would take those too, quietly, every month. The number is there so you can see it if it ever grows. Nothing is thrown away on your behalf."
    ]
  },
  {
    version: "3.58.0",
    label: "A map that shows the way you went",
    changes: [
      "A map in a story can be a journey now, not just a spot. Add a Map block and there is a list of stops under the map: search for a place or click the map to add the next one, drag a pin to correct where it sits, name them as you like, and move them up and down until they are in the order you travelled. The map draws them as numbered pins and joins them with a line, so a week of moving about reads as one picture instead of a paragraph of place names. A map with a single stop is exactly the pin it always was, and every map already in your stories is untouched.",
      "The caption underneath writes itself from the names — \"Bolzano → Ortisei → Cortina d'Ampezzo\" — so you rarely have to type one. Leave a stop unnamed and it says how many stops there are instead, rather than offering a caption with a hole in it.",
      "The line runs straight from stop to stop. A story map is there to say which places, and in which order — not which roads, which would mean asking a mapping service on the internet about where your family has been. This app asks the internet for nothing but the map squares themselves, and that has not changed.",
      "Somebody reading a story you shared with a link sees the route exactly as you do.",
      "The block's own menu used to offer \"Move the pin\", which stopped being the whole truth; it says \"Edit the map\" now."
    ]
  },
  {
    version: "3.57.3",
    label: "A backup brings your two-factor with it",
    changes: [
      "A backup now carries the key to your two-factor codes. Those codes work against a secret the server keeps scrambled, and the thing that unscrambles it is a small file beside the database rather than anything inside it — so a backup was taking the locked secrets and leaving the key behind. Restoring onto the same server was fine, because the key had never gone anywhere; restoring onto a new one quietly meant everybody using an authenticator app had to set it up from scratch, and nothing told you until somebody tried to sign in. The key travels in the backup now, and a restore puts it back with the database. The one you were using before is kept next to it, in case you go back to an older backup later.",
      "Backups taken before this release don't have the key inside them. Restoring one of those onto the same server is still fine — nothing was ever lost there. Onto a fresh server it still means setting two-factor up again, so if that is a situation you might one day be in, take a new backup when it suits you.",
      "Restoring a backup no longer leaves two stray working files behind in your data folder. They were harmless, but they sat there for good once a restore had finished."
    ]
  },
  {
    version: "3.57.2",
    label: "A review shows the book it is about",
    changes: [
      "A review turned up without a picture wherever the app talks about it — on the home page, in the Send dialog, in your inbox, beside a note. A review wears the artwork of the book it is about, and the part of the app that answers \"what is this thing?\" was only looking for pictures among your photographs, where a book's cover has never been. It looks in your books now, and only in the ones you can open."
    ]
  },
  {
    version: "3.57.1",
    label: "More than two hundred at once",
    changes: [
      "Selecting more than 200 photos and then setting a place, setting or shifting a date, tagging them, or deleting them failed with a line of programmer's English — \"ids: Too big: expected array to have <=200 items\" — and changed nothing. Each of those is sent to the server in batches now, so a selection of any size goes through, and the notice afterwards still counts everything that changed and everything that was skipped. If something goes wrong part of the way, it says how many had already been changed rather than pretending none of them were.",
      "When somebody publishes a story, a card about it appears on everyone else's home page, alongside the notes, albums and family-tree entries already there — the one thing somebody actually sat down and wrote was the one thing the front page never mentioned. Drafts are never announced, and the home page still doesn't report your own doings back to you."
    ]
  },
  {
    version: "3.57.0",
    label: "The better copy of the same photograph",
    changes: [
      "A photo's file can be replaced without losing the photo. Open it in the viewer and choose Replace file: the high-resolution scan goes in over the low-resolution one catalogued years ago, and everything stays with it — the stories and albums that show it, its tags, the people tagged in it, its date and place, who has liked it. Deleting it and uploading the better copy could never do that: it makes a new photo, and everything pointing at the old one is left pointing at nothing.",
      "The date deliberately does not move. A replacement is the same picture with better pixels, so it keeps the place in the timeline the family already knows it by — a fresh scan of a print usually carries no capture date at all, and taking the new file's own date would file a 1974 photograph under today.",
      "The file that was there is kept rather than overwritten. It moves into a \"replaced\" folder beside the Recycle Bin, so a wrong file can be put back by hand — this is the one thing the app does that would otherwise destroy the only copy of something.",
      "It has to be the same kind of thing: a photo for a photo, a video for a video. The new file may be a different format — a jpeg replaced by a tif — and the photo follows it."
    ]
  },
  {
    version: "3.56.0",
    label: "Whose story it is",
    changes: [
      "A story can be signed. Story details → Written by puts a name under the title on the cover and again at the very end, after the last chapter — where you look when you have just finished reading and want to know whose it was. It is free text on purpose: your own name, a pen name, both your names together, or the name of somebody who is no longer here to type it. It offers the names you have signed with before, your account's name first, so the second story is one click. Leave it empty and the story stays unsigned, exactly as every story is today. Guests reading a shared link see the signature too.",
      "Writing text is easier. A text block now has a small row of marks over it — bold, italic, a heading, bulleted and numbered lists, a quote, a link — acting on whatever you have selected, and pressing the same one again takes the mark off. Ctrl+B, Ctrl+I and Ctrl+K (Cmd on a Mac) do the three you already know from everywhere else. What it writes is still the same plain text underneath, so anybody who was happily typing the marks by hand can carry on and ignore the row entirely.",
      "Everything you do to a story is one group of buttons at the top of the editor: leave, publish (or put it back to a draft), send, delete. They were in three places at once — the way out in the sidebar, the rest under the chapters, and a different arrangement again on a phone. They are icons now, each naming itself when you point at it, and the page you are writing starts directly underneath instead of below a row of chrome. The sidebar holds the story's shape and nothing else.",
      "Every section's sidebar now begins where the main one does. Moving from Home into Gallery, Stories, the control panel or your profile, the first row of the menu jumped up and sat against the app's name; it stays put now."
    ]
  },
  {
    version: "3.55.1",
    label: "The same story, however it is read",
    changes: [
      "Every story is read the same way now. The last release's reading view — the page as a sheet, with the story's chapters in a column beside it — only reached stories that had chapters, so a review or a single note kept the old bar across the top and opened with bare text on white, its cover unshown even when that cover was the book's own artwork. A story of one page is no less a story: it opens on its cover like the rest, and sits in the same sheet with the same buttons beside it. It lists no days, because it has none.",
      "A guest link opens the story the way the family sees it. A shared story arrived in the narrow card every share page uses — right for one photograph or one book, a phone-shaped column for a story with four days of pictures in it. Guests now get the same sheet and the same list of chapters, with everything a guest has no business with left out: no way into the app, no Edit, no Send.",
      "In the editor, Publish, Send and Delete have moved from the bar across the top into the sidebar under the chapters — where the reading view keeps the same kind of thing, and where they are no longer a row of buttons sitting over the page you are writing. On a phone, which has no sidebar, they stay along the top.",
      "The read and edit buttons on a story's card have moved off the cover photograph to the foot of the card, across from its tag, where they wear the card rather than a shadow over somebody's photograph.",
      "A chapter's cover reached neither edge of the page while the front page's reached both. Both fill the page now."
    ]
  },
  {
    version: "3.55.0",
    label: "Knowing where you are",
    changes: [
      "The story editor opens on Overview, which is now one page rather than two. The cover, the name, the subtitle and the opening lines are still edited where they sit, and everything a reader never sees — what this story calls a chapter, the shelf it sits on, its rating, its tags — folds away underneath in a Story details card. They used to be separate panes, and the sidebar's first row, the one that opened the front page, was labelled Home under a house icon: the row that everywhere else in the app leaves for the app's own home page. A story this small has one page about itself, not two.",
      "That row is Exit edit now, and it leaves the way you came in. Open the editor from a story's page and it returns you there; open it from a collection's Add story and it returns you to the shelf you were building. Moving between the editor's pages no longer stacks up entries in the browser's history either, so Back leaves the editor rather than walking you back through the chapters you just edited.",
      "Story details wears the same folding card as a chapter's settings, in the same place — directly under the words that open the page. Two cards that hold the same kind of thing now look like the same card.",
      "Chapter settings is laid out in the order the questions come. The two dates sit side by side with \"the date is approximate\" underneath them, where it belongs, and everything about the place — its name, its pin, and using the map as the chapter's cover — is gathered under one Location heading instead of a field and a loose row of buttons. Removing a location removes it, name and pin together.",
      "Every story on the Stories page carries two small buttons in the corner of its cover: one opens it to read, the other opens it in the editor. The pencil only appears on stories you can change.",
      "A story with chapters now reads as a page with its own navigation beside it: every stop on the journey, with the photograph it opens on and the day it happened, staying in view while you read. The row of chapter names across the top could only ever show names, and on a long trip it scrolled out of sight. Underneath the list sit the things you can do with the story. On a phone, and for a story that is one plain page, the row across the top is still what you get.",
      "The map of the journey comes before the list of days rather than after it. It is how a reader gets their bearings before choosing where to start, and a list of days was a long thing to scroll past to reach it.",
      "Handing a story on is one door: Send, on the story and in its editor, holding both the people here and the guest link. Share link was a second button doing half the job, which everything else in the house stopped having a year ago.",
      "Tags are edited with the same field everywhere — on a story, on an album, on a book, on a person — chips and the box that adds them in one frame, with matches dropping down as you type. Stories and albums had a different one. The suggestions are also the right ones now: tagging a story offers the tags other stories use, rather than every tag in the house including a few hundred subject headings that came in with public-domain books.",
      "A map no longer floats over a dialog opened on top of it. Maps insist on being drawn above almost everything, so a dialog opened on a page showing one came up underneath it."
    ]
  },
  {
    version: "3.54.2",
    label: "Room to change your mind",
    changes: [
      "Every block can have its content changed, not just its heading. A photo, an album, a person, a book — the thing the block actually shows — could only be set when the block was made, so fixing a mis-picked photo meant deleting the block and adding another in its place, losing its heading, its caption and its position. The block's menu now opens with \"Change the photo\", \"Change the album\", \"Move the pin\" and the like, in the same chooser that picked it, already showing what is there.",
      "The dialogs opened from Add block came out the size of the button that opened them. The button centres itself with a technique that quietly makes it the frame every dialog inside it is measured against, so the map — the one that needs the most room — arrived as a small box in the wrong corner and was close to unusable. They open over the page again.",
      "The map dialog is much bigger, and the map fills it. Placing a pin is the whole job of that dialog and it used to be a 300-pixel strip under a search box.",
      "Add block is a dialog of the nine kinds, each with a line saying what it puts on the page, instead of a list of nine bare names.",
      "The tag on a story's card was as wide as the card, which made it read as a banner across the bottom. It is the size of its own words now."
    ]
  },
  {
    version: "3.54.1",
    label: "Covers that fill themselves in",
    changes: [
      "A review wears the cover of the book it is about. A review is about a book and a book already has a face, but a story's cover could only ever be a photograph — so writing one meant going off to find a picture of a book. Choosing the book in New story now sets its artwork as the cover, and Edit cover offers it, there and in the editor afterwards, for any story that shows a book at all. Choose a photo instead at any point and the photo wins.",
      "A chapter with no cover of its own wears the story's. Chapter pages used to open on a blank band until somebody found each one a photograph, on a story that already had a perfectly good cover. Nothing is stored: setting the story's cover fills in every chapter that hasn't chosen one, giving a chapter its own still affects only that chapter, and the editor says whose picture you are looking at — a borrowed cover is labelled, and has nothing to remove.",
      "The Add block button on an empty chapter sat on top of the line telling you the chapter was empty. It sits under it now."
    ]
  },
  {
    version: "3.54.0",
    label: "One chapter at a time",
    changes: [
      "Writing a story happens one page at a time now. The editor used to be a single scroll holding everything at once — the story's settings, then every chapter stacked underneath, each wearing its own row of nine buttons. The sidebar now lists the story's front page, its details and every chapter, and you move between them; each is a real address, so the Back button, a new tab and a link you paste to yourself all work the way they should.",
      "Chapters are put in order by dragging them in that list, instead of nudging one up or down a place at a time from whichever chapter you happened to be looking at.",
      "Words are edited where they sit. Point at a chapter's title, its opening line or a paragraph and a small pencil appears: click it, type, click away. There is still no Save button anywhere — Enter finishes an edit and Escape abandons it. Everything that can't be written into the page itself, the dates and the pin and the note, folds into one Chapter settings card underneath.",
      "Every block is a card of its own, with a handle to drag it into place, a heading if it wants one — \"Photos from Day 1\" — and a menu holding the rest: move it up, move it down, move it into another chapter, delete it. Those headings show up for readers too, and on a guest link. Add block sits under each card and puts the new block exactly there, rather than at the end of the chapter.",
      "A chapter pinned on the map can wear the map as its cover, for a day whose photograph never quite existed.",
      "A cover is changed on the cover. The button sits on the picture itself, in the editor and in the New story dialog alike, instead of in a form somewhere below it.",
      "New story is the story's front page before it exists: the cover band, then the name and the subtitle in the type they will be read in, over one card asking whatever the kind of story needs to know. The small preview card that used to sit beside the form is gone — the page you are filling in is the preview.",
      "A chapter known only by its date says so in your own language — \"Jan 6, 1998\" rather than \"1998-01-06\" — in the editor, on the story's pages and on its card.",
      "On a phone, where there is no sidebar, the same destinations run along the top of the editor as a strip, so a story with chapters can still be written from the sofa."
    ]
  },
  {
    version: "3.53.2",
    label: "A patched part",
    changes: [
      "A small piece of the web server — the part that reads the addresses inside the rules describing what a valid request looks like — has been updated to a repaired version. Four flaws had been reported in it: given a carefully malformed address it could be talked into reading one address as another, or into treating an address out on the internet as one inside the house. Nothing here ever hands it an address that came from a visitor, so there was nothing to exploit, but the fix costs nothing and the warnings are now clear."
    ]
  },
  {
    version: "3.53.1",
    label: "The guides have pictures again",
    changes: [
      "The help guides show the screens they describe. Fifteen screenshots are back: the first-run form, storage before and after it is set up, all three steps of the Add-library wizard, the libraries list, each of the three kinds of library, the family tree and the email settings. They were taken out last month because they had been captured on a real library and showed a real person's name in them. These were captured on a library built for the purpose — public-domain books from Standard Ebooks and Project Gutenberg, LibriVox recordings, openly licensed photographs — so there is nobody's private material in them. The pictures are fetched over the network rather than bundled for offline use: a guide read with no connection still reads, it just reads without them.",
      "The line under the app's name in the sidebar is translated. It had been written straight into the page instead of being looked up like every other piece of text, so it stayed in Russian no matter which language you had chosen — the one Russian sentence on an otherwise English screen."
    ]
  },
  {
    version: "3.53.0",
    label: "One way to share",
    changes: [
      "Every place that decides who can see something now uses the same panel. Libraries, story collections and family-tree branches each had their own — three lists that granted the same kinds of access to the same people and groups, and looked and behaved differently doing it. There is one now: the same rows, the same avatars, the same coloured roles, and a short glossary underneath saying what each role actually allows. Everyone sits in that list as a group like any other, at the top where the widest grant belongs, instead of being a banner off to one side — so you can see that the whole household already has access before you go granting it to somebody individually.",
      "A collection is edited in the same dialog that created it. Renaming a shelf used to mean typing over its title in the header, and its description was a box sitting under it — nothing said those were edits, or that they saved. Edit now opens the New collection form with everything filled in, cover included, and Delete lives there too, since deleting a shelf is a change to the shelf rather than an action on the page you are reading.",
      "The collection page tells you what is on the shelf: its description, the span of dates its stories cover, and how many there are. An empty frame closes the timeline where the next story will land, so adding one no longer means going back up to the header.",
      "Adding a story to a collection offers the whole New story form — the kind, dates, place, the book being reviewed, a cover — instead of asking only for a title. A story born on a shelf deserves the same start as one born anywhere else; the only difference is that the shelf is already chosen.",
      "Reviews can tell an audiobook from an ebook. The book picker always searched both shelves, but nothing on screen said which was which, so a title held in both formats appeared twice, identically. Each row now carries its format, and the list can be narrowed to one.",
      "Collection cards on the Stories page are the size they should be. A cover shot in portrait — a phone photo, most of them — stretched its card to nearly three times its height and dragged the whole row with it.",
      "Those cards also show the collection's description now, and the date span of what is on the shelf."
    ]
  },
  {
    version: "3.52.1",
    label: "A filter you can see",
    changes: [
      "Opening a photo's folder from the home page no longer leaves the rest of the Gallery filtered. That link has to say which library the folder belongs to — folder names repeat between libraries — but the library it named then stayed behind as a filter you never chose, so coming back to the timeline showed a slice of your photos with nothing on screen to explain it. The library now holds only for as long as you are in Folders; a library you pick yourself still stays picked.",
      "A filter that is in force is now visible on every page it narrows. Folders, Memories, People and the Map show the same chips the timeline does — each listing only the filters that page actually applies, so a year chosen on the timeline never turns up on a page that ignores it, and a page that looks empty always says why.",
      "People has a Filter button again. Which libraries the faces are gathered from is the one thing that narrows that page, and there was no way to set it there — a People page emptied by a filter looked exactly like having no people at all."
    ]
  },
  {
    version: "3.52.0",
    label: "Nothing waits forever",
    changes: [
      "A library could get stuck saying it was scanning and never stop. If the server was restarted or killed at the wrong moment often enough, the scan was abandoned — correctly — but the library was never told, so it wore the scanning notice for good, with nothing on the Tasks page to explain it. Worse than the notice: the nightly scan skips any library that says it is already scanning, so that library quietly stopped being cataloged, and new photos or books in it never appeared. An abandoned scan now releases its library and writes a line in the log saying so, and every restart sweeps up any library still claiming to scan with no task behind it.",
      "Audiobook scans recover the way the others always have. An interrupted one used to sit still for half an hour before picking itself back up, and one that had used up its retries could sit as a running task forever — which mattered more than it sounds, because library and photo scans run strictly one at a time, so that single stuck task quietly blocked every scan of every kind, indefinitely. Both are gone: interrupted scans resume at once, and one that is truly finished with gets out of the way.",
      "The Tasks page now tells you when work has stopped moving. A running task that has gone quiet for too long is marked as possibly stuck — in amber, with how long it has been silent — instead of looking exactly like a task that is merely slow. How long is too long depends on the job: a catalog scan reports every couple of seconds, while a video conversion can legitimately spend an hour on one long clip.",
      "And a queue that is not moving now says why. Library and photo scans run one at a time, so several queued scans and nothing starting used to read like a broken server; the page now names the task holding the queue and counts what is waiting behind it — and if that task has gone quiet, it says to cancel it to let the rest through."
    ]
  },
  {
    version: "3.51.0",
    label: "All together now",
    changes: [
      "The Gallery's People filter could only ever ask for any one of the people you picked — pick three and you'd get everyone who appears in at least one photo, not the photo where they're all standing together. Pick two or more people now and a switch appears under the filter: flip it on and the gallery narrows to only the photos carrying every one of them at once."
    ]
  },
  {
    version: "3.50.2",
    label: "Right where you left it",
    changes: [
      "Load more in the Gallery could quietly snap back to the first page while a library was still scanning — click through a few pages, look away, and you'd find yourself back at the top, as if nothing had loaded. Browsing during a scan now keeps every page you've already opened instead of throwing them away every few seconds.",
      "Nothing else changed."
    ]
  },
  {
    version: "3.50.1",
    label: "The fine print",
    changes: [
      "The Stories guide caught up with the last release. It now explains the way back from deleting a story — the Recycle Bin, who can restore it and until when, what happens to its guest links in the meantime — and spells out the one thing worth knowing before deleting a restricted collection: the restriction leaves with it, and its published stories become visible to the whole family. Help → Stories, as always, inside the app and off the network.",
      "Nothing else changed."
    ]
  },
  {
    version: "3.50.0",
    label: "Nothing is lost",
    changes: [
      "Deleting a story is no longer forever. It goes to the Recycle Bin — the same one your deleted photos wait in — and until its time runs out an administrator can bring it back exactly as it was: chapters, text, tags, stars, guest links, all of it. While it sits there it truly sits there: it leaves every page, its guest links stop answering, and nobody stumbles over it. Restore it and everything wakes up again. Like everything in the bin, it keeps the retention window it was given on the day it was deleted, and leaves on schedule with the rest.",
      "In the bin itself, a deleted story looks like everything else: a tile with its cover, when it was deleted and by whom, and when it goes for good — with the same restore and delete-forever buttons as any photo. The library filter gained a Stories entry, so digging one story out from under a big photo cleanup is one pick. Restore all and Empty bin now mean the stories too, and the size figures still count only real files — a story weighs nothing.",
      "And deleting a restricted collection now says the quiet part out loud. Removing a members-only shelf never deleted its stories — they became standalone — but standalone published stories are visible to the whole family, which the old dialog never mentioned. It does now, in bold, before you press the button.",
      "The story delete dialog tells the truth about all this too: to the Recycle Bin, not into the void."
    ]
  },
  {
    version: "3.49.0",
    label: "Pick your own cover",
    changes: [
      "Starting a story or a collection now lets you choose its cover on the spot — the same photo picker as everywhere else, right there in the creation form, with your choice showing in the live preview before you even save. Skip it and nothing changes: a story still falls back to its first photo, a collection to its fullest shelf, exactly as before.",
      "The Collections shelf reflows into an even row of cards instead of one oversized feature — each with its own cover, its story count, and the dates it spans — and past six it steps back behind a View all, so a growing archive doesn't crowd out the stories underneath it.",
      "Story cards on the index carry more at a glance now: published or draft shows right on the cover, and a story that lives on a shelf names it alongside its dates, stars and places. The grid opens nine at a time with a Load more underneath, so a long shelf still opens fast.",
      "Search, sort and the grid/list switch moved up to sit together above the shelf — the same place you'd look for them on every other library page — instead of squeezed into a heading that could wrap mid-word."
    ]
  },
  {
    version: "3.48.1",
    label: "Steadier on its feet",
    changes: [
      "A safety net under the whole server. If something deep inside ever fails the way a damaged photo once did — an error surfacing minutes later, far from any page or scan — the server now writes down exactly what happened and carries on serving, instead of going dark until someone restarts the container. Starting up is unchanged on purpose: a server that cannot boot still stops loudly, so a real configuration problem is never papered over."
    ]
  },
  {
    version: "3.48.0",
    label: "The front page",
    changes: [
      "The Stories page was rebuilt into a proper front page. Your collections lead it — the fullest shelf as one wide card with its cover behind it, the rest alongside — and the stories follow as richer cards: the cover carries the draft flag and where the story begins, the line beneath gives its dates, its stars, and how many places it visits, and the story's kind wears a small tag. There is search now, sorting — by freshness, by date, by title — and a list view for reading the shelf as lines instead of tiles.",
      "Stories can be favorites. Every card grew a star; press it and the story is yours to find again under Favorites in the menu. The star is personal — each member keeps their own — and it follows the story wherever its card appears.",
      "The menu on the left grew up with the page. All stories, drafts, published, favorites; then the kinds — travel blogs, memories, reviews; then your collections — each line with its count, and each one a real address you can bookmark or open in a new tab.",
      "Starting a story now asks the questions that fit its kind. A memory asks when and where it happened. A travel blog asks from when to when — give it the dates and it lays out a chapter per day before you type a word. A review asks which book, and can borrow the book's name if you leave the title blank. Everything is skippable, and nothing chosen here is ever locked in.",
      "And the Back button finally behaves. However many chapters you wander through, a story counts as one step — Back returns you to wherever you came from, not backwards through every page you turned.",
      "One repair below decks: a photo with a damaged information block could, on rare occasions, take the whole server down mid-scan. It is now skipped with a shrug like any other unreadable file."
    ]
  },
  {
    version: "3.47.0",
    label: "The guest gets the good seats",
    changes: [
      "A story shared by link now reads the way it reads at home. A guest opening a chaptered story lands on its front page — the cover, your introduction, the stars if you gave any, and a card for each day — and each chapter opens as its own page, with its photo and opening line up top, the photos of that day gathered at the bottom, and a way to the day before and after. The address changes as they go, so a guest can send someone a link straight to Day 3. Everything a guest can see is still exactly what you can see, checked the moment they open it, and still nothing on their page leads into the app.",
      "Stories and collections can now be given a cover by hand. A story's cover is chosen in its editor; a collection's right on its page. Both fall back as before — the first photo in the story, the first story on the shelf — so nothing changes until you choose, and choosing is one photo picker away. The cover fronts the story's page, its card in the index, and what a guest sees first.",
      "A small repair that came out of choosing covers: a collection's title, typed right on top of a dark cover photo, could be almost unreadable while editing. It sits on its own quiet backing now."
    ]
  },
  {
    version: "3.46.1",
    label: "The manual, at last",
    changes: [
      "Stories grew fast over the last three releases and never had a page in Help explaining themselves. Now they do: a guide covering the whole of it — starting a story and what the four kinds mean, chapters and their pages, every block you can place, recording narration and where those recordings live, collections and exactly what restricting one does, reviews and the Write-a-review button, and guest links. It's on the Help page under Your libraries, and like every guide it lives inside the app, so it describes the version you're running and needs no internet.",
      "Nothing else changed."
    ]
  },
  {
    version: "3.46.0",
    label: "The family shelf",
    changes: [
      "Stories can now live in collections — shelves with a name and a cover, like “Family Story” or “Trips”. A collection's page lays its stories out year by year, and the years come from the stories' own chapter dates, so a shelf built over time reads as a timeline without anyone arranging one. Stories that belong to no shelf carry on exactly as before.",
      "A collection can be private. Its manager decides who sees it: leave it open to everyone, or restrict it to the people and groups on its list — viewers who can read, contributors who can add their own stories, managers who can tend to all of it. A restricted shelf keeps its stories out of sight properly — not just off this page but out of search, tags, book pages and sharing — for everyone except its members. Your own stories you always see, wherever they are shelved: nobody's access decision can take your writing away from you.",
      "Anyone can start a collection, and a new one starts open — restricting it is a deliberate act, one switch on its Access panel, and the panel says in plain words what the restriction does before you make it.",
      "Creating a story now asks one small question first: what kind? A plain story, a memory, a travel journal, or a review. It shapes the start — a travel journal counts its chapters as Day 1, Day 2 from the first keystroke — and shapes nothing after: any story can still become anything.",
      "And book pages grew a “Write a review” button. One press starts a review of that book — the book's card already in place, the star rating a field away, the title prefilled and yours to change. Finished reviews were already finding their way onto book pages; now starting one is just as short a trip.",
      "This closes out the stories rework that began three releases ago: the site view, the recordings library, book cards and ratings, the cross-links, and now the shelf to keep it all on."
    ]
  },
  {
    version: "3.45.0",
    label: "For the record",
    changes: [
      "A story can now hold a book. Next to photos, albums and people there is a Book block: pick anything from your shelves — audiobook or ebook, one list, searchable — and it sits in the story as a card with its cover, its author, and a way straight to the book itself. “We read this aloud that summer” finally has somewhere to point.",
      "Stories can carry a star rating, one to five, set in the editor and shown wherever the story appears. It is there for reviews — of a book, a film, a restaurant on the trip — but nothing stops you rating the family holiday.",
      "And this is the part that makes reviews real: a story that mentions a book now shows up on that book's page, under “Reviews & stories”. It works across editions — write about the audiobook and your review is there on the ebook's page too, with a small note saying which one you actually read. The books already knew their editions belong together; now the reviews do.",
      "The same thread runs the other way everywhere. A person's page in the family tree lists the stories they appear in. An album or a slideshow says which stories it appears in. Stories have always pointed at the things in the house; now the things point back.",
      "None of it needs anything new from you — the connections come from what stories already reference. The sections simply aren't there until there is something to show."
    ]
  },
  {
    version: "3.44.0",
    label: "A place of its own",
    changes: [
      "A story now reads like a small website of its own. Opening one leaves the app behind — no menus, no library chrome, just the story's name, its chapters, and a way back. A story told in chapters gets a front page: the cover, a few opening lines you write for it, the span of dates and the place it mostly happened, and a card for each chapter. Each chapter is now its own page, with the date and place over its chosen photo, a line that sets the scene, and at the bottom everything that chapter showed, gathered into one strip — plus a link to the day before and the day after. A story that is just one plain page stays one plain page.",
      "You can tell a story what to call its chapters. Write “Day” and they become Day 1, Day 2; write “Stop”, and a road trip counts its stops. It is your word, in your language, on your story.",
      "Chapters can be pinned to the map. Give each one a place and the front page draws the journey: numbered pins, one per chapter, and clicking a pin opens that day. A chapter's own page shows its spot too.",
      "The Play button on stories is gone. Watching a story run itself full-screen sounded better than it was — the pages themselves are now the presentation, made to be read and handed round. Slideshows inside a story still play exactly as before, music and all.",
      "Recordings made for a story — someone telling their part of it — now live in your photo library like everything else, instead of in a drawer of the app's own. An admin picks which gallery library they go to, once, under Settings → Stories; until then the record button simply isn't offered. Recordings made before this change keep playing from where they are, and the same settings page has a button that moves them into the library — after that they are backed up with your photos, appear in the gallery, and outlive their story.",
      "The gallery itself learned to hold sound. A voice memo or any audio file in a gallery folder is now catalogued like a photo: it gets a tile, plays right in the viewer, and Audio joined Photos and Videos in the filter. No library picks this up on its own — audio file types are added per library, and choosing a recordings library adds them for you. Slideshows, memories and the year's film keep politely ignoring audio, since none of them can show it.",
      "Under the floorboards, the database learned to rebuild a table in place — the first release to need it. If an upgrade takes a breath longer than usual on a big gallery, that is what it is doing."
    ]
  },
  {
    version: "3.43.1",
    label: "The engine room",
    changes: [
      "Housekeeping under the surface, and nothing changes on any page: the server now runs on a newer Node — the engine everything else sits on — and the bundled libraries moved to their current releases. Everything should behave exactly as it did before.",
      "The two-factor codes were given a proper check while one of those libraries was moving, because that library has form: an earlier version of it changed the unit it counted time in, and the codes an authenticator app produced stopped being the codes the house expected. They are now measured against the published reference values every authenticator follows, rather than only against themselves — which is the difference between knowing they are right and knowing they agree with us. Nobody needs to re-enrol.",
      "A stored secret too damaged to be one — a truncated setting, a half-written value — is now turned away at the door rather than handed to the decoder in pieces.",
      "It goes out on its own rather than riding along with the next set of features, because a change this deep in the machinery is only easy to trace back when it is the only thing in the release."
    ]
  },
  {
    version: "3.43.0",
    label: "The way you’d tell it",
    changes: [
      "Stories are a new way to keep something that happened. A story is a page you write: your own words, with photos and videos, whole albums and slideshows, maps, people from the family tree and quotes, dropped in wherever they belong. Nothing is copied — a story points at what is already in the house, so the photo in a story is the photo in your gallery, and it follows whatever you do to it there.",
      "A story can be told in chapters, each with a date and a place. Exact if you know it, a year if you don’t, a range if it took a fortnight, and “around 1998” if nobody is quite sure — the same kind of date the family tree has always taken. The date and place sit above the chapter the way a dateline would. A story that needs none of that stays one plain page with no chapter headings at all.",
      "Writing is Markdown: a heading is a line starting with #, bold is **like this**, a quote is a line starting with >. There is a preview button, and what it shows is exactly what a reader gets.",
      "Sharing sends the whole story at once, instead of the album and the slideshow and the photos separately. A guest link opens it in any browser with no account, and stays up to date — whoever opens it sees the story as it is now, not as it was the day you sent it. Because a story can carry a whole album, the link asks something the other links don’t: may a guest open that album in full, or only the photos the story actually shows? It is off unless you say otherwise, and off means the rest of the album genuinely cannot be reached through that link.",
      "Press Play and the story runs itself, full screen. Chapter cards, your words at a size that reads from across the room, the photos, the maps. An album plays all the way through rather than the handful the page had room for. Prose is given time to be read rather than a fixed few seconds, and a video or a recording is never cut off — the show waits for it to end. It works from a shared link too, which is rather the point: a link sent to a phone is a story that can be handed round a table.",
      "A story can also be told out loud. Record someone telling a part of it, right there in the browser, or upload a recording you already have — the voicemail nobody could bring themselves to delete. It plays inside the story, travels with a shared link, and takes the screen during the show.",
      "Tags now go on albums and slideshows, not only on photos. That is what lets one tag gather everything about a single summer — the photos, the album, the story, and the people in it — onto one page. Tagging a story puts it there beside them, and while you are building a story the pickers offer anything that shares its tags first.",
      "Where a slideshow’s finished movie is filed is now that slideshow’s own choice. Before, a single setting took every movie in the house into the same library; nobody had asked for that, and it could not be pointed anywhere else. Each slideshow now says where its movie goes — or that it should not be saved to a library at all, which is the new default. If the name is already taken it asks once and remembers the answer, because a re-render happens in the background with nobody there to ask.",
      "A slideshow will not try to file its movie into a folder it cannot write to. That used to fail at the very end, after the encoding was done; it is now checked up front and says which library is read-only."
    ]
  },
  {
    version: "3.42.0",
    label: "After the credits",
    changes: [
      "Tagging photos meant opening them one at a time. A folder of forty from one holiday, all of which should say “Crete 2019”, was forty trips through the viewer. Selecting photos now offers Tags next to Album and Place: type a tag, and it goes on everything you have selected. Tags already in use in your gallery are suggested as you type, and sit under the box as a row you can click.",
      "It adds rather than replaces, so a photo keeps whatever tags it already had. The same dialog will take a tag back off a selection, which is how a batch tagged by mistake is undone — switch it to Remove and name the same tag again.",
      "A slideshow’s clip now plays after the closing card instead of before it — the bit after a film’s credits, rather than an interruption between the last photo and the words. The card and the clip are two separate endings: have one, or the other, or both, or neither. With both, the card plays first and the clip follows it, and the music still fades out under the card so the clip arrives in its own voice.",
      "The clip that used to play at the very start of a movie has been retired. Opening on a home video was the wrong shape for a film, and the same clip does the job properly at the end. If you had chosen an opening clip for a slideshow, that choice does not carry over — there is nowhere left for it to play, and the closing slot is now where a clip belongs.",
      "Fixed: a finished movie could fail at the very last step with an “operation not permitted” error, throwing away several minutes of encoding, because something else on the server — a virus scanner, a backup or sync agent, the file indexer — happened to be holding the previous movie open for a moment. That last step now waits a few seconds for whatever it is to let go, rather than giving up on work it had already finished."
    ]
  },
  {
    version: "3.41.1",
    label: "Where you had got to",
    changes: [
      "Browsing deep into the gallery and then liking a photo undid the browsing. Every “Load more” you had pressed was quietly thrown away — the page went back to the first hundred or so photos — and if the photo you were looking at was one of the ones further down, the viewer closed itself as the list shrank underneath it. Liking now changes the heart and nothing else: the viewer stays open, and every page you loaded stays loaded.",
      "Deleting a photo takes that one photo out of the grid and off the count, rather than starting the whole page again — so the viewer moves on to the next photo with the rest of what you loaded still there.",
      "The changes that really do redraw the grid — rotating a photo, editing its date, tagging someone in it — still reload, but they now bring back everything that was on screen instead of only the first page. The same is true of liking or deleting a whole selection at once. Both the timeline and the folder view were affected, and both are fixed."
    ]
  },
  {
    version: "3.41.0",
    label: "Look what came in",
    changes: [
      "Photos arriving in the gallery never announced themselves. Books did — a scan that brought twenty of them in put a card on the home page saying so — but a phone emptied into the house on Sunday left no trace on the page you open first, and you found the photos by remembering to go and look. New photos now has a card of its own: the newest few, the number that came in, and a tap that opens the viewer on all of them rather than the four on show.",
      "It covers the past week and nothing further back, and in a week when nothing arrived it is simply not there — an empty shortcut to the gallery is not worth a place on the page. It is one card for the whole week rather than one per day: a camera unloaded across three evenings is one arrival to a person, not three. Like everything else in the feed it settles as it ages, opening under the day’s memories and sinking below the week’s conversation.",
      "“View all” opens the gallery ordered by when things arrived rather than when they were taken, which is the order the card was showing. The timeline’s sort menu always offered that; now a link can ask for it."
    ]
  },
  {
    version: "3.40.2",
    label: "The folder you clicked",
    changes: [
      "Searching for a folder in the photo picker and then clicking the folder you found dropped you back at All folders, with the search box emptied and the folder you picked nowhere in sight — you had to go and find it by hand, which is what you were searching to avoid. Clicking a result now opens that folder, as it always should have. Clearing the search yourself still takes you back to the top, and you can search again from wherever you have got to.",
      "It showed up in “Add photos to this event” on the family tree, but the same picker is what the gallery and the slideshow title card use, so it was the same everywhere and it is fixed everywhere."
    ]
  },
  {
    version: "3.40.1",
    label: "A line that could stop the house",
    changes: [
      "A fix worth going out on its own: looking up a person could have hung the whole server, and not by anything you did. The tidy-up that trims a repeated year range off a Wikipedia one-liner — turning “English novelist (1775–1817)” into “English novelist” — could be made to run for minutes on a single short line of text, and while it ran, nothing else in the house was served. Anyone can edit a Wikipedia page, so the line that triggers it was never yours to control. The same tidy-up now finishes in under a millisecond on text a thousand times longer.",
      "Biographies and blurbs from the online sources also stopped inventing punctuation that was never in them: a source that wrote an escaped angle bracket had it read back as a real one. It never became markup on the page — these are always drawn as plain text — but a biography should say what its source said."
    ]
  },
  {
    version: "3.40.0",
    label: "Only what you searched for",
    changes: [
      "Metadata Lookup used to answer a title with everything loosely related to it. Searching “The Hobbit” brought back Frankenstein, The Housemaid and the King James Bible, because every source behind the dialog runs a keyword search and hands over whatever shares a word. It now returns only results that carry every word you typed, ranked so the closest titles come first — across all sources at once, rather than eight from one and then eight from the next. If a search comes back empty it says so and suggests a shorter query, which is a better answer than a page of wrong books.",
      "The search box opens with the title alone rather than the title and the author. An author sitting in the box is another word every result has to match, and sources spell names differently enough (“Leo Tolstoy”, “Лев Толстой”) that it quietly ruled out the right book. Type one in yourself when a common title needs narrowing.",
      "Applying a result is now yours to shape. Instead of “update details” and “update cover”, there is one tick per field a result can fill — cover, title, authors, narrators, year, publisher, language, ISBN, ASIN, tags, description — all on by default. Untick the year and the year you already have stays, while the narrator you were actually after still arrives. A source that is right about one thing and wrong about another is no longer all or nothing. Details lays the two side by side and greys out whatever you excluded, so you can see what applying would do before you do it.",
      "Applying a match that carried new cover art appeared to do nothing to the cover. The art was fetched and stored correctly — the page simply kept showing the copy your browser already had, because the address of a book’s cover never changes when the picture behind it does. Covers now change address whenever they change, so a new one shows up the moment it lands, in the grid as well as on the book.",
      "FantLab joins Find info as a source for the people behind your books, alongside Wikipedia and Open Library — which between them know little about Russian authors and nothing about Russian narrators. It answers with a biography, dates, country and a portrait, in Russian. Narrators are covered too: they are a separate kind of record there, and pasting either a fantlab.ru/autor… or a /dictor… link works. Its portraits show up in the photo picker as well.",
      "Fixed: portraits from Wikipedia were blocked from loading in the Find info results by the app’s own security policy — visible only on a real deployment, never in development."
    ]
  },
  {
    version: "3.39.0",
    label: "A line about the person",
    changes: [
      "An author or a narrator had a biography and nothing else — several paragraphs, or a blank space, with no middle ground. The people behind your books now carry the short facts that belong above one: when they were born, when they died, where they were from, and what they did. A page opens with \"American novelist and journalist · 1899 – 1961\" under the name, which is usually the thing you actually wanted to know, and the biography follows for when you want more than that.",
      "Dates are written the way people know them rather than the way a date picker demands. A bare year is a complete answer for someone born in 1775, and typing one no longer means inventing a month and a day you do not have — the same convention the family tree has always used. Sources spell dates every way imaginable, and whatever they hand over arrives tidy or not at all: nothing half-read gets stored.",
      "Find info is where most of these will come from, and it has been rebuilt as the same search the books already had. A source to narrow to, a search box, checkboxes for what to take, and a row for pasting a page you have already found. Results arrive as cards with a photo and the facts on them, each with Apply and a Details view that lays the current values beside the found ones and marks what would change. Nothing is written until you press Save, so a result you applied and thought better of costs you a Cancel.",
      "That search box being editable fixes something that had simply never worked: the old dialog searched the stored name verbatim, so anyone filed as \"Twain, Mark\" could never be found at all. Now you fix the spelling in the box and search again.",
      "Narrators get all of this too, and one thing more. The automatic lookup that runs during a scan checks that a page is about the right kind of person before trusting it — and its list of occupations was written for authors, so narrators described as plain \"actor\" were being skipped without a word. They are not any more, and the check still throws out the same-name stranger who turns out to be an Irish sportsperson.",
      "The whole editor now matches the one you get for a book's metadata — the same tabs, the same two-column fields, a photo tab where a book has its cover, and a window that stays the same size whichever tab you are on instead of jumping about as you switch. Editing a book and editing the person who wrote it should not feel like two different applications."
    ]
  },
  {
    version: "3.38.0",
    label: "The whole branch at once",
    changes: [
      "Family tags are what decide who may edit which part of the family tree — give a cousin editing rights on a tag and they can maintain everyone carrying it. But tags could only be put on one person at a time, from inside that person's own edit form, so handing somebody their side of the family meant opening every profile in it and typing the same word again. There are now two places to do it to a whole group at once, and a family of thirty is one pass.",
      "The Families page is the obvious one: every family card carries a tag button, and it opens with that family's members already gathered. The People page is for a branch that isn't one surname — Select turns the grid into checkboxes, All takes everyone the current search and tag filter have left on screen, and Tags acts on what you ticked. Tagging one person on their own still works exactly where it did.",
      "Add relatives is the part that does the real work. It grows the selection along the tree itself — partners, children, parents, and onwards through theirs — instead of by surname, because a name is a poor guide to a family: a wife who kept her own belongs to the branch without sharing it, and a stranger who happens to be another Ivanov does not. Anyone who doesn't belong comes off the list with a click before you apply anything.",
      "Tags add up rather than replace. Someone can sit in two branches and carry both, and a bulk add never disturbs what a person already has — which the single-person form, working on a whole tag set at once, could not promise. Each tag has three states rather than a checkbox: give it to everyone in the selection, take it from everyone, or leave each person as they are. A tag nobody has touched says what is true of the selection instead of describing a change that isn't there.",
      "Assigning tags is still administrators only, for the same reason as before: if editors could tag, they could pull any person into their own branch and hand themselves rights over them."
    ]
  },
  {
    version: "3.37.0",
    label: "One place to share",
    changes: [
      "Sharing something was two dialogs pretending to be one. Send to listed the family and let you tell one of them about a book; choosing \"share link\" closed it and opened a second dialog, built on the same machinery, which made guest links on one tab and listed who already had access on another. So \"who can see this?\" had two answers in two places, and changing your mind halfway meant going back out through a menu. There is one dialog now, and everything finishes inside it.",
      "It opens on the three ways to share, side by side: people, a link, your e-reader. Choosing one changes what is underneath rather than sending you somewhere — links are made, listed and revoked on the spot, and the list of who already has access, with the button that takes it away, sits at the foot of the people list where it belongs. The old dialog is gone entirely.",
      "You can now pick several people at once. Tick as many as you like and write one line for all of them; if any of them can't open it yet, the dialog says so before the button changes to \"Give access and send\", and access is given to exactly those who needed it. And if the server couldn't reach somebody after all, it says who, instead of reporting a clean success.",
      "People in the list carry a coloured initial and their email address, which is the only thing that separates two members of a household who share a first name. Past five of them the list grows a search box.",
      "Guest links still show their address exactly once, when you make them — only a fingerprint of the link is stored, so nothing can print it again later, and the dialog now says as much where you would look for it. Each link keeps its label, its expiry date and its own Revoke.",
      "The photo gallery's albums keep their own link flow, since an album link is a snapshot of what was in the album at the time and is not the same animal as a link to one book."
    ]
  },
  {
    version: "3.36.0",
    label: "Which one is your author?",
    changes: [
      "Find Info used to pick one page and hand it to you as the answer. It searched Wikipedia and Open Library, took the first thing that looked plausible, and if that turned out to be a different person with the same name — which happens far more often than you would think — nothing on the screen said so, and there was no way to reach the right one short of hunting down the address yourself. It now brings back everything it found, and you choose.",
      "The matches sit in a list down one side: a photograph, where it came from, and a line saying who this is, which is usually all it takes to tell two people sharing a name apart before you take anything of theirs. Choose one and it opens beside your author's current biography and photo, side by side, exactly as it always did — the comparison has not changed, only what it is comparing. A match can be expanded to read its whole biography without leaving the list, or opened at its source in a new tab.",
      "Searching a writer's name also turns up the books written about them and the ideas named after them: Ayn Rand came back with a biography by somebody else and with Objectivism, neither of which is a person you can put in an author profile. Those are gone. Each page is now checked against Wikidata for whether it describes a human being at all, which reads the same in every language — the guard it replaces only ever recognised English job titles, so it did nothing for a Russian library.",
      "Folded under each match is what settles a tie when the description does not: the language of the page it came from, birth and death dates, what the author is best known for, how many works are on record.",
      "The tab also opens on something plainer. Two ways in, weighted honestly and side by side — search the web, or paste a page you already have in hand — instead of one button standing next to an input box you had to read twice to work out which was which.",
      "Fixed: the count of changes waiting to be saved followed whichever match you were looking at, so taking a biography and then glancing at another match made your own change appear to vanish. It counts what you have changed now, and stays put.",
      "New: authors can be created by hand. The Authors page has a New author button, the way Narrators has had one all along — for the writer whose books have not arrived yet, or the one your files never named properly. A name is enough; a sort name and a biography if you have them. It opens their profile straight away, ready for a photograph."
    ]
  },
  {
    version: "3.35.0",
    label: "Who's at the door",
    changes: [
      "The control panel had two pages answering the same question. Overview had a Sign-ins page, and the Dashboard had a Logins view, and both drew the same chart of successful and failed sign-ins over the same events — but only one of them could tell you where a sign-in came from, and only the other one listed the attempts one by one. They are one page now: Sign-ins is what the Dashboard opens on, and it kept everything both of them did.",
      "Which means the attempt-by-attempt list finally narrows with the rest of the page. Filter to one country, one address or one person and the raw attempts follow, where before they always showed the whole house no matter what the panels above them were describing.",
      "What is signed in and what happened now share one card, with a switch between them, because the answer to \"who is at the door\" is both of those things and you should not have to scroll past fifty sessions to reach the second half. Each side carries the graph of its own shape: sign-ins over time, and — new — a bar per person of the devices they are signed in on, which is how you find whoever has quietly accumulated forty of them.",
      "The list of attempts also stops overstating itself. It holds the newest few hundred, and it now says so plainly, with the true total for the window on the tab beside it and the rest where it always was, in Logs.",
      "Every link to the old addresses still works, including a shared drill-down with its country or address still attached, so nothing anybody saved has gone stale.",
      "The Dashboard's Libraries page rearranged its four lists into two pairs: who wrote and who narrated on the top row, what is heaviest and where the photos pile up below. That last one is new — the folders holding the most photos, counting the folder each photo actually sits in rather than rolling everything up into the library it is somewhere inside, so it names the place to go and not the place you started."
    ]
  },
  {
    version: "3.34.1",
    label: "Nothing to see here",
    changes: [
      "Housekeeping under the surface, and nothing changes on any page: the engine that finds and recognises faces in your photos moved to its current release, along with a couple of bundled libraries that had patched versions waiting. Face grouping should behave exactly as it did before.",
      "It goes out on its own rather than riding along with the next set of features, because a change this deep in the machinery is only easy to trace back when it is the only thing in the release."
    ]
  },
  {
    version: "3.34.0",
    label: "A library of quotes, not a list",
    changes: [
      "The quote of the day now opens the home page. It is the one card that is the same for everyone in the house and changes every morning, so it sits at the top instead of drifting down as the day's photos and arrivals pile up above it.",
      "It also stops offering you every category at once. A library with thirty of them made a wall of chips; the card shows eight, and that selection moves along a little each day so everything comes round in time — the same eight for everyone, like the quote itself.",
      "Or tell it what you like. The card has its own preferences now: a language, so you can read the app in Russian and still get English quotes (or the other way round), and the categories you actually care about. Pick some and they become your card's whole switcher, with the quote drawn from all of them together. Pick none and it draws from everything, as before.",
      "The Quotes page can cope with thousands. It searches as you type — across the words, the author, the source, who said it and the note — and it searches properly in Russian, where \"цитата\" now finds \"Цитата\" instead of nothing at all. It loads fifty at a time as you scroll and says how many there are, and the category filters carry counts that follow whatever you have searched for.",
      "Adding a quote is one screen again. The form had grown to ten fields in a narrow column; it is wider now and split in two: the quote, its source, a note and who may see it on the first tab, and the family member who said it, categories, language and dates on the second.",
      "Fixed: portraits in the family tree were cropped down the middle, which took the top off almost every head — a service portrait or any photo framed with the face high lost its crown. They crop from the top now, so the face survives and it is the shoulders that go."
    ]
  },
  {
    version: "3.33.1",
    label: "Tabs that mind their own branch",
    changes: [
      "Fixed: the control panel's tab row listed every page in a group, so opening Utilities › Widgets › Quotes put \"Duplicate cleanup\" and \"Missing photos\" beside it — pages that have nothing to do with quotes. The row now shows only the pages in the branch you're standing in, and a branch holding a single page shows no row at all, so Quotes reads as the page it is. Moving between branches is what the left nav is for, and Gallery's two pages still sit side by side exactly as before.",
      "The Widgets branch also has its own icon now instead of borrowing the one the Quotes page already wears."
    ]
  },
  {
    version: "3.33.0",
    label: "Second thoughts",
    changes: [
      "Quote packs are managed from the control panel now, under Utilities › Widgets › Quotes. Bringing one in decides what the whole house reads, which is why it was already something only an administrator could do — so it sits with the other administrative tools rather than on the Quotes page, which is where everyone reads and writes their own.",
      "More to the point, an import can be taken back out. Every pack you bring in is remembered as the event it was — the file it came from, when it arrived, and how many of its quotes are still here — and each one has its own Delete that removes that pack and nothing else. Quotes you typed in by hand, passages you highlighted while reading, and other people's quotes are all left alone, and the file can always be imported again.",
      "The list counts what is left rather than what arrived, so a pack you have been weeding by hand reads honestly: \"12 of 40 quotes left\".",
      "This is what makes a quote pack off the internet worth trying. Import a few hundred, see what they do to the quote of the day, and if they are not what you hoped, one button puts things back. There is also a blunter \"delete all imported\" on the Quotes page for everything that ever came from a file."
    ]
  },
  {
    version: "3.32.0",
    label: "Words worth keeping",
    changes: [
      "Quotes grew up. What was a private list of passages you'd highlighted while reading is now the family's own book of sayings — the line from a novel, the toast someone makes every year, the thing your four-year-old said at breakfast that everyone still repeats. Mark a quote as shared and the whole house sees it on the Quotes page, with a note of who saved it; keep it private and nobody else ever will. Every reading highlight stays private unless you say otherwise.",
      "The home page carries a quote of the day. Everyone in the house sees the same one, all day, and a new one the next morning — and it works its way through the whole collection rather than repeating at random. It prefers quotes in the language you read the app in, and each person can point their own card at a category: one of you reads only the funny ones, someone else takes whatever comes.",
      "Some days it isn't a quote of the day at all. If something was said on this date in an earlier year, that is what the card shows — \"7 years ago today\", above the words and whoever said them. Writing down when a saying was said is what makes it come back.",
      "Quotes can belong to people. Attach one to someone in your family tree and it appears on their page under a new Quotes tab, with the date and the circumstances you wrote down. Rename them and their sayings follow the new name; remove them from the tree altogether and the sayings stay put, still in their name rather than going anonymous.",
      "Categories are yours to invent — Funny, Kids, Wisdom, Toasts, Grandma. A quote can wear several, the editor suggests the ones already in use so the family settles on a handful instead of fifty near-duplicates, and only categories that quotes actually wear are ever offered back to you.",
      "Administrators can bring in a whole collection at once from a JSON file; public-domain quote packs are easy to find online, in any language. Choosing a file only checks it — you see how many are new, how many you already have, and which lines couldn't be read, before anything is saved. Importing the same pack twice is harmless, and one bad line never spoils the rest.",
      "Quotes go into collections now, alongside books and photos, so \"Things the kids said\" can be a real shelf. There is a new guide for all of it under Help & guides → Quotes.",
      "Fixed: links inside the built-in guides that pointed at a particular section opened the right guide but left you at the top of it. They jump to the section now."
    ]
  },
  {
    version: "3.31.1",
    label: "Audiobooks and Ebooks catch up",
    changes: [
      "Fixed: Audiobooks and Ebooks were left out of 3.31.0's Russian translation — the browse pages, authors, narrators, series, categories, tags, and the library-creation wizard in the control panel all still spoke English while the rest of the app had switched. They're translated now, along with the Audiobook/Ebook/Gallery badge shown wherever media types mix, and the \"N selected\" count on every browse page's toolbar."
    ]
  },
  {
    version: "3.31.0",
    label: "Speaking your language",
    changes: [
      "iSputnik now speaks Russian, top to bottom — not just a few headline screens, but every menu, button, and message across browsing, the audiobook and ebook readers, the family tree, galleries, the control panel, and your profile. Pick it from Profile → Appearance (English / Русский); it applies immediately, is remembered on your account, and is mirrored to this device too, so the sign-in screen and the offline app already know your language before a session even exists.",
      "Counts read correctly in either language — «1 файл», «2 файла», «5 файлов» — instead of a single English-shaped plural stretched over every number.",
      "The messages you actually read when something goes wrong are translated too, not just the menus around them: a mistyped password, an expired two-factor code, an email address already in use — these speak your language now instead of switching back to English the moment something fails.",
      "Left in English on purpose: past release notes on this page, and the open-source credits below them — those are a historical and legal record, not app copy, so translating them after the fact would mean inventing new text for something that already happened. Your own titles, folder names, and photo captions keep whatever language you gave them."
    ]
  },
  {
    version: "3.30.0",
    label: "Minimalist by default",
    changes: [
      "There's a new theme, and it greets everyone at the door. Minimalist is platinum grey and black ink in the spirit of a certain beige computer — near-white windows on a warm grey desktop, a monochrome accent ramp, the primary button in classic black-with-white-type, and no scene artwork anywhere. A fresh install now starts on it: the sign-in screen, the first admin account, and every invited member wear Minimalist until someone chooses otherwise. Existing accounts keep whatever they picked.",
      "The Expanse theme is retired, but its colours live on: Plain Dark now wears the whole Expanse palette — cyan accent, copper highlights, deep blue-black canvas — without the station backdrops, which is what Plain always promised. Accounts that had Expanse (and an install that had it as the default) move to Plain Dark automatically, so they land on the same colours they chose.",
      "The sign-in screen got a proper welcome. The big title now introduces the house — \"Your personal hub for stories, knowledge, and imagination\" — the panel carries a small service emblem, and phones finally see the hero instead of a bare form. The sign-in button is the mission control piece now, stars and all. The QR code is gone: \"Link a TV or display\" already does that job properly, and now sits behind a clean «or» divider.",
      "The big title also stopped wrapping mid-word. \"isputnik\" used to break into \"isputni-k\" on tablets and smaller desktop windows; the title now scales with the room the panel leaves it, at every width.",
      "The Night theme's pop-out player flies past a new backdrop — a rocket climbing through the dark — and the Light theme's player shares the same artwork in daylight tones, so the two read as the same instrument panel on different shifts.",
      "Spring cleaning behind the walls: dead styles from the long-retired System tab, a never-rendered metric tile, and a handful of colour variables nothing referenced anymore are gone."
    ]
  },
  {
    version: "3.29.1",
    label: "The sky holds still",
    changes: [
      "The scene behind every page is pinned to the screen now. On a long page — a library of hundreds of books, a deep photo timeline — the backdrop used to stretch itself across the entire scroll height, blowing the artwork up into a blur and dragging it along as you scrolled. Now the sky is exactly one screen tall and stays put: the page scrolls, the stars don't.",
      "The Night theme's warm glows got the same anchoring, so they no longer smear across a long page either. Every scene surface benefits — home, the control panel, and the Expanse theme's stations alike."
    ]
  },
  {
    version: "3.29.0",
    label: "Night theme with a space program",
    changes: [
      "iSputnik Night is a different place now. The old soft teal made way for a retro cosmos: a near-black sky behind everything, lettering in warm cream and brass, and one deep signal red for whatever matters most on screen. Text sits in a typewriter face, the whole window wears a thin brass frame with a faint star chart behind it, and the sidebar opens with the ship's plate itself — a red star and «ВАШИ ИСТОРИИ — НА ОРБИТЕ».",
      "The Home page reads like a mission console. Feed cards became riveted panels with an inner frame, progress bars glow launch-red, resume buttons turned into brass instrument knobs, and the little red star marks each card's eyebrow. Navigation rows light up with a red indicator edge when you're on them.",
      "The audiobook player got the full instrument-panel treatment: the big red launch button now says what pressing it will do (Play or Pause, right on the button), the seek bar became a ticked gauge with a mint thumb, volume and speed live in their own console cluster, and the chapters list opens as a framed overlay panel instead of swallowing the screen.",
      "Only Night changed — Light, Plain and Expanse are exactly as they were, and the theme picker's swatches show the new palette honestly, so you know what you're choosing before you choose it."
    ]
  },
  {
    version: "3.28.2",
    label: "One photo picker, everywhere",
    changes: [
      "Choosing photos — for an album, a slideshow, a family member, an event, a portrait — is now one dialog everywhere, and it grew real ways in: browse by folder as before, or flip to People (everyone the face scan knows, biggest named people first, each with their photo count), to Tags, or to All photos with a proper text search. One search box adapts to whichever tab you're on.",
      "What you pick stays picked as you move around. Gather two photos from a folder, three of Grandma from People, one from a tag — the selection rides along the bottom as a row of little thumbnails, each with its ✕, and one Add button takes the lot. The people and tag rows stay put while the photos scroll, so you always know whose photos you're looking at.",
      "The family tree now uses the same picker instead of its own copy. Its special powers came along: a linked person opens with their face matches already showing, the Upload tab still lands new files in the tree's chosen library and attaches them in one step, and picking a portrait is still one tap. What it gained is everything it never had — tags, text search, other people, the whole timeline.",
      "Fixed: opening \"On this day\" from the Home page and pressing Next could wander into photos from a day or three away — days the card itself had deliberately left out. The viewer now browses exactly the day the card shows, and only widens when the day itself is thin."
    ]
  },
  {
    version: "3.28.1",
    label: "The memory card earns its place",
    changes: [
      "\"On this day\" picks its four photos with intent now. Every year gets a place before any year gets a second one — a single year with many photos can no longer crowd the others out — and within a year, photos with a person in them come first. Four covers chosen for variety beat the first four in date order.",
      "The card also stays honest about what \"this day\" means. Widening the match by a few days exists to rescue scanned photos dated slightly off, and it now only happens when the day itself is thin — a date with plenty of its own photos shows exactly those, not neighbours dressed up as anniversaries. The Memories page keeps its wider net, where each year labels how close its match is.",
      "Opening a photo from the card now gives you the same viewer the gallery has, powers included: rotate, delete, editing the description, date, location, people and tags — each appearing exactly when your library permissions allow it — plus the guest-link option when sending, and a folder name that clicks through to that folder. It used to be a look-but-don't-touch copy.",
      "Tapping the third photo in the strip opens the third photo. It used to open the first photo of that photo's year, which is only the same thing by luck.",
      "Fixed: on a desktop browser, pressing play on \"pick up where you left off\" swallowed the whole page with the phone player. It now opens the small player window, like every other play button on desktop — the page you were reading stays where it was. Phones and the installed app keep the full-screen player, which is where it belongs."
    ]
  },
  {
    version: "3.28.0",
    label: "A home page that is different every day",
    changes: [
      "The Home page is a feed now. Instead of the same fixed rows in the same fixed order — rows that looked identical on Tuesday and on Monday unless somebody added a book — the page is one column of cards, ranked by what deserves your attention today, and it simply ends when it runs out. What kind of thing a card is decides how long it stays: some leave when you act on them, one lives exactly a day, most fade away over a couple of weeks.",
      "Something a family member sent you sits at the very top, above everything else, and stays there until you decide — it never drifts down the page as other things happen. And deciding no longer means going somewhere else: Like and Not now are right on the card.",
      "\"On this day\" became a strip of actual photographs, each stamped with its year, opening straight into that year's photos full-screen. It is gone at midnight and tomorrow's day takes its place — the reason the page is worth glancing at even on a day nobody added anything.",
      "New books arrive as one card per day they came — \"14 books joined the library on Sunday\", a fan of covers, and the rest a tap away — instead of ten loose tiles saying the same thing ten times. What everybody else has been up to — a note left, an album made, someone added to the family tree — appears the same way, each event its own card, written as a sentence.",
      "When you finish a book in a series and the next one is already on the shelf, the feed says so: \"You finished Foundation — Foundation and Empire is on the shelf.\" One suggestion at a time, rotating daily rather than nagging, and only ever a book you haven't opened.",
      "Pick up where you left off — the one-tap resume card phones have had since the mobile home — now sits pinned above the feed on every screen, with a quiet count of what else is in progress. The four statistics tiles that used to open the page are gone: numbers that change by single digits a month were furniture, not news.",
      "The \"Around the house\" page in the profile menu is retired along with its menu entry — the feed is where the household's doings live now. Nothing is lost when a card fades: the notes themselves stay on the books and photos they were written about, where the next person to open them will find them."
    ]
  },
  {
    version: "3.27.0",
    label: "Your year, cut from the photos you liked",
    changes: [
      "Slideshows opens on a year card now — \"2025 in review\", and the year before it — built from the photos and videos the household liked over that year. Nothing is saved until you open one and keep it: it arrives in the ordinary slideshow editor with the music, the transitions and the title card all still yours to set. The year still running is honestly labelled \"so far\" rather than pretending to be finished.",
      "A year film is cut by the calendar first and by the likes second. Sorting a year by likes and taking the best sixty gives you a film about the one week everybody happened to be tapping — usually the summer trip — and nothing else. So every month that has photos in it is guaranteed a place, months you were busiest in get more of them, and the ranking only decides what fills the places. Thirty frames of the same sunset fold down to the best one, and no single face is allowed to carry the whole reel.",
      "The heart moved onto the photograph. Every tile — Timeline, Folders, Albums, People, Memories — carries one in its top-left corner, so liking a photo as you go past costs a single tap instead of opening it, liking it, and coming back. In the full-screen viewer, F does the same thing: arrow through a trip and press F on the ones worth keeping, without the hand leaving the keyboard.",
      "The gallery filter learned about likes: show only what you liked, only what anyone in the house liked, or only what nobody has yet. The middle one is exactly the signal a year film is built from, so it is also how to see what next December will have to work with — and what it won't, while there is still time to go and tap some hearts.",
      "Favorites is called Likes now, in every place it appears: the sidebar, the page, the heart on a book, the heart on a photo, the player. \"Favorite\" and \"like\" mean the same thing to anyone reading them, and having the app print one word while the house says the other was a small tax on every conversation about the feature. The heart itself is unchanged, and old /favorites links still open the right page.",
      "Fixed: the Likes page counted photographs as books — \"1 book\" underneath a photograph — and its empty state told you to go and open a book. It has held photos and videos ever since the gallery got its heart; it now says so."
    ]
  },
  {
    version: "3.26.0",
    label: "Slideshow movies open like films now — and end like them",
    changes: [
      "The title card's words can be set in one of five faces — Classic, Serif, Bold, Script and Typewriter — at three sizes, chosen from a row of buttons each drawn in its own lettering. Every face covers Russian as well as English, the preview above redraws with the real thing, and a slideshow that never touches the setting keeps rendering exactly the card it always did.",
      "A movie can end on a closing card: \"The End\" (or anything you write instead) with up to six lines of credits underneath — filmed by, the music, who it's for. Same backgrounds as the opening card, same lettering, its own length. It's off until you turn it on, so existing movies end as they always have.",
      "With music set, the soundtrack now fades out underneath the closing card — the photos end at full volume, the credits play the music down, and the movie ends in silence — instead of the flat two-second dip every movie used to end on. The opening card's \"my own line\" also grew up: it takes several lines now, not one.",
      "A movie can open on a clip — a bit of video that plays before everything else, like a studio ident before a film — and can carry a second clip after the last photo, before the credits. Any video in your galleries qualifies, chosen through the same folder browser used for adding photos; up to twenty seconds of it plays.",
      "A clip brings its own sound, unless you switch that off. While it plays the music pauses — properly pauses, picking up afterwards from where it left off rather than skipping ahead — so a recorded greeting or a toast opens the movie in its own voice and the song carries on underneath the photos. A clip whose file has no sound simply leaves the music running.",
      "The Title card dialog became Title & credits: the card's picture on the left with what it says right underneath, every setting on the right, and an Opening/Closing switch across the top. The picture never scrolls out of view while you adjust things — choosing lettering you can't see would be guesswork.",
      "Fixed, found while proving the clips: a video anywhere in a slideshow — not just these new clips — cut the rendered movie short at that video's last frame whenever transitions were on. A photo can hold its final frame through a cross-fade; a video's file simply ends, and everything scheduled after it was silently lost. Videos now hold their last frame through the transition the way photos always have, and the movie runs its full length."
    ]
  },
  {
    version: "3.25.1",
    label: "Emptying the bin now has to be meant",
    changes: [
      "Fixed, and this one had teeth: narrowing the Recycle Bin to a single library and pressing Empty emptied the entire bin — every other library's deleted files went with it, and nothing on screen suggested they would. Empty now follows the library picker exactly as Restore all beside it always has, and the dialog says which of the two it is about to do.",
      "Emptying the whole bin now asks you to type the number of items back before it will go ahead. It is the only action in the app that destroys many files at once with nothing left to restore from, so it is the only one that asks. Emptying a single library — bounded by a library you deliberately chose — still asks in the ordinary way.",
      "Both dialogs now open by saying exactly what is about to be lost: how many items, how much disk, how many files, and how many of those were still inside the retention window they were given and would not have gone on their own. The old wording said only \"every item in the bin\", which reads the same whether the bin holds three or three thousand.",
      "The counts in those dialogs are now the ones that will actually happen. The search box and the filters narrow the tiles, but Empty and Restore all work on the whole library you picked — so \"Restore all 3 items\" could quietly put back forty. Both now count what they reach.",
      "The Empty button is switched off while there is nothing to empty, rather than opening a dialog about nothing."
    ]
  },
  {
    version: "3.25.0",
    label: "The recycle bin stops emptying itself",
    changes: [
      "Fixed, and it is the reason for this release: a scheduled task named \"Empty recycle bin\" shipped switched on, and it did exactly what its name said — once a week it emptied the bin completely, whatever the retention window sitting beside it promised. Something deleted on Saturday could be gone for good on Sunday, with no warning, having never looked close to expiring. Nobody chose that schedule; it was simply on. It has been removed, and the removal reaches installs that already have it.",
      "In its place, running nightly, is \"Purge expired recycle bin items\". It takes only what has outlived the window it was given at the moment it was deleted — so 30 days now genuinely means 30 days, and an item still inside its window is never touched. Clearing the bin regardless of retention is still available, as the Empty button on the Recycle Bin page, where you can see what you are about to lose before you lose it.",
      "The task reports what it actually did, rather than a bare count: that nothing was due, or how many it removed — or, when a library's disk is offline, how many it had to leave for the next run rather than orphaning their files somewhere it could not reach."
    ]
  },
  {
    version: "3.24.0",
    label: "Author pages, rebuilt — with a website, a location, and an editor that says what it will do",
    changes: [
      "An author or narrator's page now looks like every other detail page in the app: a round portrait beside their name, the Back and action buttons together at the top, and an Overview / Books / Audiobooks tab strip under it. Their titles are listed properly too — bigger covers, no box drawn around every entry, and the narrator, running time and year each on their own line.",
      "Authors gained a website and a location, shown beside their biography and edited like any other field. A bare address is fine: type \"agriddle.com\" and it displays exactly that while still linking out correctly.",
      "Editing a person is one dialog with three tabs. Details holds the name, sort name, website and location beside the photo; Biography is the long text on its own; Find Info looks them up online. Choosing a picture opens its own box, offering a file from your computer — dragged straight onto the photo, if you like — or one found online.",
      "Find Info used to open on two similarly-named buttons either side of a box, with nothing to say which one you wanted. It now opens with a single Search button and states plainly that nothing changes until you press Save changes. Each result says what it did — \"Added to the form\", \"Ready to save\", \"Already saved\" — and a line at the top counts what is waiting to be saved. Pasting a link to a specific page is still there for when the search finds the wrong person, folded away until you need it.",
      "That promise now holds. Taking a biography filled the form and waited for Save, but taking a photo wrote it to the server immediately — so Cancel could not undo it, and nothing warned you. Both are now applied together when you save.",
      "An author's photo can be removed again, which was never possible before.",
      "Fixed: uploading a photo for an author had never worked, and was refused before it began. Finding one online still worked, which is likely why it went unnoticed for so long.",
      "Fixed: the Back button on a person, series, category or tag page now returns to wherever you actually came from, stepping back through your history rather than always jumping to the top of the list. Opening one of those pages from a bookmark or a new tab still falls back to the list, as it must.",
      "Fixed: a family member's portrait had been quietly drawn as a rounded rectangle instead of a circle."
    ]
  },
  {
    version: "3.23.0",
    label: "Lock a folder, and nothing inside it can be deleted from the app",
    changes: [
      "In the gallery's Folders view, an admin looking at a folder — with the filter narrowed to one library — now has a Lock folder button beside Rescan. Locked, that folder and everything below it refuses deletion outright: a photo picked by hand, a whole selection, an audiobook whose folder happens to sit under the locked path — the server says no whoever asks, until the same button unlocks it. Locked folders wear a small padlock on their tile so everyone can see they're protected.",
      "The lock stops exactly one thing: deleting. Viewing, uploading into the folder, editing dates and places, rotating, tagging and rescanning all carry on as before. It's a guardrail for the folders that must survive a careless moment — the wedding photos, the scans of the old albums — not a read-only switch. Protecting a whole library remains the library's own setting, as ever.",
      "Duplicate cleanup understands the lock the way it already understands a read-only library. A copy in a locked folder is shown but never offered for removal — it wins the keeper contest instead, so the copies elsewhere are the ones proposed to go. A folder with a lock anywhere inside it is never offered for clearing out, the wizard's Clear choice is greyed for locked folders with the reason on hover, and locking a folder after a cleanup has already scanned makes its affected offers refuse cleanly rather than fail halfway.",
      "If a selection mixes locked and unlocked items, the unlocked ones still go to the Recycle Bin and the message says how many were left behind because of a lock — distinct from items skipped for lack of permission, so the outcome reads as what actually happened."
    ]
  },
  {
    version: "3.22.0",
    label: "A video filmed sideways can be turned upright, just like a photo",
    changes: [
      "The rotate buttons in the viewer now work on videos. Turn a clip left or right and it rights itself there and then — it keeps playing while it turns — and its thumbnails everywhere in the gallery turn with it. Old phone videos that came in lying on their side can finally stand up.",
      "As with photos, the file on disk is never modified: the turn is remembered by the app and applied wherever the video is shown. Which also means a downloaded original still plays the way the camera saved it — the turn belongs to the gallery, not to the file.",
      "While a video is turned, the player wears the app's own control bar — play, seek, mute — instead of the browser's built-in one. The browser draws its controls inside the picture, so they would have lain on their side along with it. Turn the video back upright and the familiar controls return."
    ]
  },
  {
    version: "3.21.0",
    label: "Tell the app which machine your proxy is, and forged addresses stop being possible",
    changes: [
      "A new setting, TRUST_PROXY, takes the address of your reverse proxy itself — an IP or a range, like 172.18.0.0/16 for a Docker network — and the app believes a forwarded client address only when the machine that passed it along is actually on that list. The old TRUST_PROXY_HOPS counted proxies without checking who they were, which works, but rests on nothing but the promise that the app can't be reached any other way; if it ever can be, a visitor can put any address they like in the forwarding header and be believed. Named addresses close that: a forged header from anyone not on the list is simply ignored.",
      "Nothing changes for existing setups — TRUST_PROXY_HOPS keeps working exactly as before, and if both are set, the addresses win. The ranges use the same notation as trusted networks, IPv6 included, and a typo in the list is reported at startup and left out rather than trusted by accident.",
      "Everything that keys on knowing the real client honors the new setting the same as the old: trusted home networks, the skip-two-factor-at-home rule, and TV linking. The Security overview shows which form of trust is in effect, and its advice — along with the hosting guide, the Docker examples and the Unraid template, which gained a \"Trusted Proxy Addresses\" field — now points at the address form first."
    ]
  },
  {
    version: "3.20.2",
    label: "A backup that takes its time is no longer reported as a failure",
    changes: [
      "Creating a backup from the Maintenance page held the browser's request open for the whole time the archive was being written — minutes, on a library of any size. Anything between your browser and the server that won't wait that long (Cloudflare gives up after about a hundred seconds) then reported an error for a backup that was in fact completing fine on the server. Now the server confirms the backup has started right away, and the page watches the list until the finished file appears — then says so, or shows what actually went wrong if something did.",
      "While it's being written, the backup shows in the list as \"Backing up…\" with its size climbing, and holds back its Restore, Download and Delete buttons until it's whole — a half-written archive is not something to restore from. Pressing Create again during a run politely refuses rather than starting a second one, and a scheduled backup that comes due mid-run is skipped for the day, since the running one is that day's snapshot.",
      "A backup that fails now says so in two places: on the page, with the reason, and in the activity log — including scheduled runs that fail overnight, which previously had nowhere to report to."
    ]
  },
  {
    version: "3.20.1",
    label: "The reverse-proxy setting keeps meaning what it says",
    changes: [
      "The web framework this app is built on dropped support for the way TRUST_PROXY_HOPS was passed to it: a hop count, which used to mean \"trust this many forwarding steps\", is now quietly ignored — trust nothing. Left alone, that would have made every visitor behind your reverse proxy look like they came from the proxy's own address, and everything that works per-address — rate limiting, failed-sign-in lockout, IP blocks, trusted home networks — would have treated the whole household, and the whole internet, as one client. The app now applies the hop count itself, with exactly the meaning it has always had. Nothing to reconfigure; if you never set TRUST_PROXY_HOPS, none of this concerns you.",
      "The framework changed this for a defensible reason: counting hops can't tell a real proxy from a liar, so the setting is only safe when the app can't be reached except through the proxy. That has always been the rule here — it's in the hosting guide, and the app already warns when the setting doesn't match the traffic it sees — and it is unchanged.",
      "Under the surface, this release also carries the usual round of library updates, including new major versions of the library that builds zip downloads and the one that keeps offline listening data on your device. No behavior changes; downloads and offline playback work as before."
    ]
  },
  {
    version: "3.20.0",
    label: "A person's relatives read as a family tree, and every one of them is named",
    changes: [
      "A person's Relationships were five labelled lists — Parents, Siblings, Grandparents, Partners, Children — which say who somebody is related to but not how. Which parent goes with which, which siblings share which parent, which children came from which partnership: a second marriage was unreadable in that shape. The same cards are now laid out by generation, oldest at the top reading down to the children, with the person themselves marked in the middle row beside their partners and siblings, where a pedigree puts them. Everything the lists could do is still there — edit a relationship, remove a child, add a relative.",
      "Grandparents are grouped by the parent they came through. Four names in a line say 'these are your grandparents'; two pairs, each under the parent they belong to, say which side of the family each one is, which is the question anybody actually has when they look.",
      "And every card says what that person IS to you: Father, Mother, Grandmother, Brother, Sister, Son, Daughter, Wife, Husband. The shape of a tree implies the relation; a word states it, which is the difference between a chart you read and one you work out. Where the record does not say a gender the neutral word is used — Parent, Sibling, Child — never a guess.",
      "The page's own controls moved to where every other page keeps them. A book and a photo carry their actions in a bar at the very top; a person carried the same four a third of the way down, under the birth dates, while the bar above held only Back. The same controls now sit in the same place whatever kind of thing you are looking at, and the back control matches the one those pages use.",
      "Somebody with no relatives recorded gets a sentence and a pointer at Add relative, rather than a tree of one person. And the little stem that joins one generation to the next is no longer drawn under somebody who has no children — it used to hang there pointing at nothing, for anybody childless, however full the generations above them were."
    ]
  },
  {
    version: "3.19.0",
    label: "The household can pass things to each other, and talk about them where they are",
    changes: [
      "Anything in the library can now be passed to somebody in the household. On a book, a photo or a person in the family tree, one **Send to** button opens a list of names; pick one, add a line if you want, and it arrives for them. What travels is a pointer, never a copy — no file is mailed, nothing is duplicated, and they open it in their own account with their own progress.",
      "It replaced two buttons rather than adding a third. \"Send to e-reader\" and \"Share\" were separate entries in separate menus that both meant get this thing to somewhere; both are now destinations inside the one sheet — a person, your own Kindle or Kobo, or anyone at all through a guest link. The e-reader row only appears on books, and when no device address is saved it reads \"Set up my e-reader\" and takes you there, which is the first time that feature has been visible from outside Profile.",
      "Giving somebody access stopped being a separate errand. The names list has a second half — Doesn't have access yet — holding the people who can't open the thing because it lives in a library they were never given. Picking one grants them read access and tells them in a single press, with the button reading \"Give access and send\" so nothing happens quietly. Before this, the answer to \"why isn't Mum in the list?\" was a different dialog. Someone with only viewing rights still sees who is missing, greyed out, and cannot be the one to widen it.",
      "Sending a file to another person's Kindle is deliberately not offered, even though the server knows the address. It lands in their Shared with me instead, and they send it to their own device if they want it.",
      "Shared with me absorbed the things people send you, so there is one page rather than two lists reporting the same event twice. Anything still undecided sits at the top under Waiting for you, with who sent it and what they said, and two buttons: Save puts it in your list, Not now clears it away without telling anybody. Acting on a card drops it into the shelf below with everything else you can open.",
      "A dot on the Profile button means there is something you have not looked at. Opening the page clears it whether or not you decided anything, so nothing accumulates into an unread count that has to be dealt with.",
      "None of it sends email unless an administrator turns it on, under Settings → Notifications, and that switch is separate from the existing one for shares: a household that wanted share notices has not thereby agreed to be mailed every time someone passes a book along.",
      "Notes arrived at the same time: a box under a book, a photo or a person in the family tree that says Add a note, and what gets typed stays under that thing for good. They are flat — no replies, no reactions, no counts — and plain text, stored and shown exactly as typed. Anyone who can see a thing can write on it, including view-only accounts: refusing a note to somebody already allowed to send you that book with a message would be incoherent, and the accounts it would silence are the children's.",
      "You can take your own note back, and an administrator can take back anyone's; it stops being listed either way. On a person, the tab that held their life story was called Notes and is now called Biography, so the page has only one thing by that name.",
      "Albums and slideshows can be sent too, which is usually what somebody means anyway — 'look at Summer 2019' more than any one photo of it. An album carries the same destinations as anything else, and picking somebody who has never been given it grants them the album as it tells them; the album's own Share dialog kept the list of who has access and the guest link, and stopped being a second way to hand it out. A slideshow is send-only: it is visible to whoever can see the photos in it, exactly like an album, but there is no way to hand one out, so there is nothing to grant and no link to make.",
      "Both became addressable while that was done — an album and a slideshow now have their own web address. Back, reload and open-in-a-new-tab work on them, and a sent album lands on the album rather than on a list of thirty.",
      "The button on a card says where the thing goes: Favorite, not a vague Save that left you wondering. Things with nowhere to be saved to — an album, a slideshow, a person — get a single Done instead, because 'Not now' reads wrong once you have looked at it.",
      "Anything sent to you now shows on the Home page, first, under 'Sent to you' — with the cover, who sent it and what they said. It was previously behind the profile menu under a small dot, which is findable by somebody who already knows it is there and by nobody else. The row disappears when there is nothing waiting.",
      "And it says what is actually being asked. 'Dad wants you to listen to this', 'Mum wants you to see these photos' — read, listen, watch or look, depending on what the thing is, rather than the same 'sent you this' for everything. If they wrote a line, their line is shown instead.",
      "Send to on a book carries its name beside the icon rather than only in a tooltip. It is the one action in that row somebody has to come across rather than go looking for.",
      "And a second row, Around the house, for what everybody else has been doing — notes left, albums and slideshows made, people added to the family tree — written as sentences rather than cards: 'Anna left a note on Dune', with what she actually wrote underneath. Six on the Home page, the rest on their own page.",
      "It leaves things out on purpose. Your own doings are not listed, because you know about those and at five people they would crowd out everybody else's. New books and photos are not either — the Recently added row already says that. Anything about a thing you cannot see never appears at all.",
      "A note can carry an emoji, and now there is a button to find one with: forty of the ones a household actually uses, inserted where the cursor is. Emoji always worked — they are plain text like the rest of a note — they were just hard to reach at a desk. Notes stay plain text on purpose: rendering formatting is exactly what would turn a note into something that has to be made safe before it can be shown."
    ]
  },
  {
    version: "3.18.0",
    label: "The same settings never score lower at home than on the internet",
    changes: [
      "The protection level used to grade a home-only server on a shorter exam, so one medium setting cost more of the score there than it did on the internet — the same settings could read 88 at home and 94 on the internet. Both now sit the same exam. A home-only server has the four questions that only matter against strangers waived — proxy trust, a second factor from outside the house, deletion protection and IP reputation are credited in full whatever they are set to — and sign-in alerts and device linking count half. Identical settings now score identically, and at home they can only score higher.",
      "The card names the waived settings instead of just counting them, and counts them as active, so the counters agree between the two gradings.",
      "When the proxy in front of the server is already trusted, the card's reminder to switch the grading is a single quiet line; the louder warning is kept for a proxy the app has not been told about."
    ]
  },
  {
    version: "3.17.1",
    label: "A home-only server is graded only on what matters at home",
    changes: [
      "The protection level for a server on the home network only now leaves out four settings entirely rather than counting them for a little: proxy trust, a second factor from outside the house, deletion protection, and IP reputation. None of them has anything to do when there is no outside — there is nothing to front, nobody outside to ask for a second factor, no outside to refuse deletes from, and no strangers' addresses to score. The card says how many settings are set aside. An internet-facing server is graded as before."
    ]
  },
  {
    version: "3.17.0",
    label: "Security grades itself — a protection level, and a policy table that says what's weak",
    changes: [
      "The Security overview used to restate the settings as cards and call the server \"Protected\" no matter what. It now opens with a protection level: a ring around a shield, a word — Strong, Good, Fair, Weak or Critical — and a score out of 100, with counters for how many policies are active, optional, off, or have an issue (on, but unable to work: an alert with no email set up, a proxy that is there but not trusted).",
      "The score depends on one thing only you can tell it: whether the server is home network only or reachable from the internet, chosen with two buttons on the card and remembered. A home-only server is graded gently on the defences that only matter against strangers — a second factor from outside and IP reputation aren't counted at all, and a reverse proxy, sign-in alerts and deletion protection count for little. An internet-facing server is held to all nine, with proxy trust, the second factor and sign-in alerts counting most: they are how strangers are kept out and how you hear about the ones who got close. If requests are arriving through a proxy while the card says home-only, it says so.",
      "Under the card, a Policies table: one row per protection — proxy trust, lockout, auto-block, two-factor outside the house, sign-in alerts, deletion protection, device linking, the password policy, IP reputation — each with its current value, a Strong, Medium or Weak grade, and an arrow to the setting that owns it. The password policy grades Strong only when passwords must be eight characters and mix three of lowercase, uppercase, numbers and symbols; a direct connection grades Medium, because a trusted reverse proxy in front is a layer of its own.",
      "Blocked IPs learned to tidy itself: chips above the list count and filter running, permanent and lapsed blocks, and Clear lapsed removes the automatic blocks that have already run out in one confirmed click. The AbuseIPDB check moved off the row and into the opened record, as on the Logins table; the arrow at the end of a row opens that address's Sign-ins page. Trusted networks shows how many live sessions sit inside each range, and both tables fit their page without scrolling sideways. The Policies tab's cards are ordered by how much they matter.",
      "Grades and statuses are now drawn in colours that mean the same thing in every theme — green, amber, red — rather than in a theme's accent, which in the plain themes had turned \"good\" blue."
    ]
  },
  {
    version: "3.16.0",
    label: "Logs you can narrow, sort, open and export — and Tasks joins the dashboard",
    changes: [
      "The Logs page was hiding most of what its server could do. It now opens with a date toolbar — All for the whole archive, or the same hour-to-month presets and custom range the dashboard uses — and every column heading sorts. The event filter lists each event by its full name, so \"auth.login_failed\" is a filter of its own rather than a corner of \"auth\"; the list is searchable, so typing a category still finds its events.",
      "The arrow at the start of a log row opens the whole record underneath it, in the same layout the Logins table uses. A person's name in a row is now a link into their Sign-ins page, and an outside address into its own — the archive and the analytics finally point at each other. Addresses inside the house stay plain text; there is nothing to dive into.",
      "A download button exports exactly what is on screen — every row matching the window, filters and sort, not just the current page — as a CSV file. It is built by the same query as the table, so the file can never disagree with the screen, and anything that looks like a spreadsheet formula is defused before it is written.",
      "Tasks moved from its own tab to a view on the Dashboard, beside Libraries. It opens with four cards — what is running, what is queued, how many tasks failed this week, and when the last one finished — and a row saying when the next scheduled run is due, which opens Maintenance › Scheduled jobs. The finished history, once an unfiltered list, can be narrowed to failures only, to one kind of task, or to one library. Running and queued tasks keep their live progress and cancel buttons; old addresses for Tasks land on the new view.",
      "Both pages show ten rows at a time and sit tighter, and the log table now fits its page exactly — a long detail line is clipped with an ellipsis instead of widening the table past the edge, and opens whole with the row."
    ]
  },
  {
    version: "3.15.0",
    label: "A System tab that answers \"is the server well?\", and Statistics becomes the Libraries tab",
    changes: [
      "The dashboard's System tab used to list counts — users, sessions, invites, log entries — two database sizes that disagreed with each other, and a health light that could only ever say \"Operational\". It now opens with four cards about the server itself: uptime with the version and Node release under it, memory in use, free space on the data disk (green until a fifth is left, amber below that, red below a tenth — the one number that can end an evening on a media server), and the database on disk with its file and WAL sizes in one place.",
      "The counts didn't vanish; they became a short table of doors. Members, signed-in devices, open invite links, log entries and — new — when the last backup was taken, each with its number and an arrow to the page that owns it. The hand-written sqlite3 backup tip is gone; backups have had a page of their own for a while, and the table now says so.",
      "Statistics was a page behind a media-type switch, with the same Libraries table, size card and biggest-files list drawn three times over. It is now the Libraries tab on the dashboard, beside Activity, and shows every type at once: a card each for audiobooks, ebooks and photos & videos plus the total on disk; every library in one table, biggest first, with its share of the storage drawn beside its size; and three short lists side by side — top authors across both book types (the same person is often on the shelf and in the ears), top narrators by hours, and the biggest gallery files, where one video can outweigh a thousand photos.",
      "The dashboard's tabs read Logins, Locations, Activity, Libraries, System. Bookmarks to the old Statistics page land on the Libraries tab, and searching for \"statistics\", \"system health\", \"activity\" or \"map\" from the control panel's search now opens the right tab directly rather than the dashboard's first one."
    ]
  },
  {
    version: "3.14.0",
    label: "One Activity tab, with a date range of its own",
    changes: [
      "The dashboard's Activity, Content activity, and Reading and playback tabs were three slices of one question — what has the household been doing with the library? — and are now one Activity tab that answers it top to bottom: the headline numbers, two charts, the recent events themselves, and what everyone has open right now. The dashboard's row of tabs is down to four: Logins, Locations, Activity, System.",
      "Activity now has the same date toolbar as Logins. Pick the last hour, seven hours, a day, a week, a month, or a start and end of your own, and the cards, both charts and the events table all follow it together; short windows chart by the hour, long ones by the day. Each card compares its number with the equal stretch before — uploads and downloads up reads green — and storage used is broken down into audio, books and photos.",
      "A second chart joined the first. Uploads, downloads and deletes were always drawn; what was actually opened — played, read or viewed — was recorded but never charted. It is now, beside the first, so a quiet week of adding things and a busy week of enjoying them look different at a glance.",
      "The list of what is currently in progress keeps its place at the bottom, unchanged in meaning and labelled plainly as a snapshot of where each person is rather than a history — it does not follow the range above, because a reading position is overwritten as you go, not logged session by session.",
      "Every table on the tab shows ten rows at a time, the login count left the Activity cards (sign-ins have their own pages now), and bookmarks to the old Content activity and Reading and playback tabs land on Activity."
    ]
  },
  {
    version: "3.13.0",
    label: "Sign-ins becomes the one place for devices and sessions",
    changes: [
      "The Devices page and Members › Sessions were both, at heart, the same list — everything signed in to the house — seen from two doors. Both now live on the Sign-ins page, right under the chart: the familiar counters (so many displays, phones, tablets, computers) sit above the table, and each counter is now also a filter — click \"3 displays\" and the table narrows to the three TVs, click it again to let go.",
      "Ending a session no longer means walking to another page. Every device row carries a sign-out button; it asks first, says exactly what it will do — sign that person out on that device, touching nothing else — and the counters update the moment it's done. Your own session is pinned to the top of the list, marked \"This device\", and has no such button: signing yourself out is what the sign-out in your own menu is for.",
      "Because the table lives on Sign-ins, it follows your dive: scope to one person and it's their devices; scope to a country and it's what is still signed in from there. It always describes right now, though — a device list bound to last month would be a riddle — and the page says so where the table starts.",
      "Every table on the page shows ten rows at a time and sits a little tighter than tables elsewhere — six tables deep, it reads as the investigation it is rather than six screens of scrolling.",
      "Old addresses keep working: bookmarks to the Devices tab or to Members › Sessions land on Sign-ins. The Members section is now Users, Groups and Invite links — the people, not their machinery."
    ]
  },
  {
    version: "3.12.0",
    label: "A real map of sign-ins, and a Sign-ins page that answers who, where and from what",
    changes: [
      "The Locations map is now a real map — the same one the photo gallery uses. Drag it, zoom it, and read actual geography instead of flat country shapes. Countries appear as bubbles sized by how many sign-ins they carried, towns as gold dots when a city-level database is in use, and home as its ring. Clicking any of them still highlights the matching row in the table, and the table highlights the map right back.",
      "One thing to know about the trade: drawing this map fetches its background tiles from OpenStreetMap, the same place the gallery map already gets them — the only outside address the app permits. Nothing about a sign-in is in those requests, and the addresses themselves are still looked up on your own server, against the database kept with your data.",
      "The tables under the map grew up. Every country and town now carries its flag, its share of the traffic drawn as a bar beside the count, and a colour-coded fail rate — green for a clean record, amber for some failures, red for an address under attack. Sort by any column, page through ten rows at a time, and the home network keeps its own pinned row at the bottom.",
      "The arrow at the end of each row opens the new Sign-ins page: pick a country, a town, a single address or a single person, and every panel answers for exactly that — cards, a chart over time, each address with its location, block status and the scanner traffic no other page shows, each person with how they signed in, the devices still signed in from there, and the sign-in names strangers tried that belong to no account here. Every arrow is a further dive, the address bar carries the scope so a view can be shared, and the back button walks the dive back out.",
      "A Filter button on that page sets the scope by hand: choose everything, a country by name, a town, an address pasted from an alert, or a member picked from the list — for when the thing you want to examine isn't already a row on screen."
    ]
  },
  {
    version: "3.11.1",
    label: "Two-factor sign-ins now appear on the dashboard",
    changes: [
      "If your household signs in with a two-factor code, yesterday's new Logins, Devices and Locations pages were missing almost every sign-in — the cards, the chart, the table and the map counted only sign-ins made without a second factor, while the Logs page listed them all. A sign-in completed with a code is now counted like any other, a rejected code counts as a failed attempt, and both appear in the table with their own labels. Nothing was lost: the events were always recorded, only the counting was wrong, so the corrected figures cover your whole history."
    ]
  },
  {
    version: "3.11.0",
    label: "The dashboard opens on sign-ins, with pages for devices and where people connected from",
    changes: [
      "The control panel's dashboard now opens on Logins. Pick a window along the top — the last hour, seven hours, a day, a week, a month, or a start and end of your own — and everything below follows it: cards for attempts, successes, failures and blocked addresses, each compared with the window before it, a chart of successful and failed sign-ins, and the sign-ins themselves in a table.",
      "A row in that table opens. It shows the address with the person under it, the sign-in method as an icon you can hover for its name, and the result; the arrow at the start opens the whole record underneath — the event, the logged detail, the exact time, and everything known about the address. Sort by address, person, method or time, and choose 10, 20, 50 or 100 rows to a page; it remembers which you picked.",
      "With an AbuseIPDB key set under Security, each row also carries a shield whose colour is the signal: green for a clean address, amber for one with some history, red for one the community calls abusive, and a house for your own network. Nothing is sent to AbuseIPDB unless you press Check on an address, and an address inside your own house is never sent at all. The Blocked IPs page now shows the country and network operator alongside the score.",
      "A new Devices page counts every device signed in to the house — displays, phones, tablets and computers — and lists them: what the device is, whose account it is signed in to, where it last connected from, when it was last seen, and when its sign-in runs out.",
      "A new Locations page draws a world map of where sign-ins came from, with a table of countries beside it and a line under the map that reconciles the total: how many the map could place, how many came from your own network, and how many no database could place. Countries are worked out on your own server from a database file kept with your data — about 9 MB, fetched with one press — so no address is ever sent anywhere to draw the map.",
      "That database is yours to choose. For town-level detail, download any city database you like and hand it over by pasting its link or picking the file; towns then appear as dots on the map. And because a home network has no country to look up, you can mark where home is by clicking a map, and your own connections get a dot of their own."
    ]
  },
  {
    version: "3.10.5",
    label: "An email address is no longer refused for the space around it",
    changes: [
      "Signing in with an address that carries a stray space — pasted out of a message, or with the space a phone keyboard adds after the tap — used to be turned away as though the address were misspelt. The space is now trimmed before the address is checked, so \"you@example.com \" simply works. The same applies when setting the server up for the first time, and when an administrator adds or edits someone. A space in the middle of an address is still wrong, and still refused."
    ]
  },
  {
    version: "3.10.4",
    label: "The Listen button stands out, and every icon is freshly drawn",
    changes: [
      "On a phone, the row of actions along the top of a book, audiobook or photo used to wrap onto a second line. It now holds six icons at most and anything further along drops into the ⋮ menu, so the bar stays on one row. Listen (or Read) is picked out in gold, so the thing you came to do stands out from the icons around it.",
      "Opening a photo on a phone now matches the book pages: no title across the top, and a back arrow at the left instead of a close button at the right. On a desktop the title and close button are unchanged.",
      "The interface icons have been updated to the current release of the icon set that draws them. Around sixty are redrawn — the calendar, clock, camera, download arrow and others are a little cleaner and more consistent with each other. Everything still means what it did before; nothing moved.",
      "Housekeeping under the surface: the library that checks the shape of everything sent to the server moved to its current major release. Wherever it now words a rejection more technically than before, the friendlier wording was kept — a form field you left blank still simply says \"Required\"."
    ]
  },
  {
    version: "3.10.3",
    label: "Stronger two-factor secrets — authenticator users need to set theirs up again",
    changes: [
      "**If you sign in with an authenticator app, you have to set it up again after this update.** Two-factor secrets are now 160-bit, twice the length of the ones this app issued before and the size RFC 4226 recommends; the library that checks your codes no longer accepts the shorter kind at all. Your existing app entry will stop being accepted, and the sign-in screen will say so rather than just calling your code wrong. Sign in with one of your backup codes, then in Profile → Security turn two-factor off and set it up again to scan a fresh QR code. If you're on your home network, you may not be asked for a code at all — sign in as usual and go straight to setting it up again. If you have no backup codes left, an administrator can reset two-factor for your account from Members → Users.",
      "Anyone receiving their codes by email is unaffected — there's no shared secret involved, so nothing changes and there's nothing to redo.",
      "Under the surface this moves two-factor onto the current release of the library that generates and checks the codes. The tolerance for a phone clock that runs slightly fast or slow is unchanged at ±30 seconds, and codes with a space in the middle are still accepted."
    ]
  },
  {
    version: "3.10.2",
    label: "The System page grows into a dashboard, and the library starts counting what gets played",
    changes: [
      "Overview → System is now Overview → Dashboard: the same server-health numbers, plus a row of tabs for Activity (logins, uploads, downloads and deletes charted over the last two weeks, plus storage used), Logins (a breakdown by sign-in method, and a table of who signed in from where), Content activity (recent uploads, downloads, deletes, reads, plays and views in one list), and Reading and playback (what's in progress right now for every member). Real tabs, not a dropdown — old links to the System page still work.",
      "Playing an audiobook, reading an ebook, or opening a photo in the gallery is now recorded the same way a download always was — at most once every 30 minutes per item, so ordinary use doesn't flood the log — which is what feeds the new dashboard's numbers and shows up searchable in Logs alongside everything else."
    ]
  },
  {
    version: "3.10.1",
    label: "Toolbars that fit your phone, and photos that open without their notes already up",
    changes: [
      "On the phone app, a book or audiobook's toolbar used to lay out every icon in a single row that ran off the edge of the screen. Listen (or Read) now sits right after the back arrow, and everything that doesn't fit — Add to collection, Mark finished, Reset progress, and whichever of Edit, Download, Send to e-reader, Share, or Delete are left over — tucks under a new ⋮ menu, so the whole bar stays on one line.",
      "The photo viewer's toolbar gets the same fix: on a phone it now stays within the screen instead of spilling off the side, with Add to collection and any leftover actions folded into the same kind of ⋮ menu.",
      "Opening a photo on the phone app no longer immediately covers it edge-to-edge with the details panel — that panel opened by default because it's handy on a bigger screen, but on a phone it left barely any of the photo visible. Tap the ⓘ button when you want it; the photo itself is what opens now."
    ]
  },
  {
    version: "3.10.0",
    label: "It takes a code to drop two-factor, and shared photos forget where they were",
    changes: [
      "Turning off two-factor, minting fresh backup codes, or changing your sign-in email now asks for a current second factor — an authenticator code or a backup code — not just your password. A stolen password used from a live session could quietly strip the second factor or move your login to an address the thief controls; now the one wall meant to stand when a password has already fallen can't be pulled down with that same password. Accounts that never turned two-factor on are unaffected, and the disable, backup-code, and change-email screens simply gain a code field when you have it on.",
      "A photo shared with a guest link no longer carries the hidden data your camera wrote into it — the timestamp, the camera model, and above all the GPS coordinates, which for a picture taken at home are your address. Shared photos are now re-encoded on the way out with that metadata dropped, so a link you hand a relative shows them the picture and nothing about where you were standing. If a photo ever can't be safely re-encoded, the link declines it rather than fall back to the original.",
      "The server no longer runs as root. The container starts privileged just long enough to take ownership of your /config folder, then drops to an ordinary user — PUID/PGID, 1000 by default, or 99:100 on the Unraid template — for everything after. So if a malformed upload ever found a flaw in the image, audio, or e-book tools that parse it, what it landed in would be an unprivileged process, not root with the run of your whole media share. Existing installs are brought over once on the first restart; there is nothing to set.",
      "Your SMTP password and AbuseIPDB key are now encrypted where they rest, so a backup that finds its way onto a less careful drive is inert rather than a working credential. The key that unseals them is kept out of the backup, so restoring onto a brand-new host means re-entering those two secrets once — the two-factor guide notes this.",
      "A broader hardening pass sits under the surface: a private library's covers and a book's listening progress can no longer be read across accounts by guessing an id, saved-token and share links are masked in the server log, the in-app guides are sanitized before they render, session and two-factor cookies wear a stricter same-host prefix over HTTPS, unknown addresses behind a misconfigured proxy are treated as untrusted rather than waved in, and the bundled image, archive, and web libraries are moved to their patched releases."
    ]
  },
  {
    version: "3.9.0",
    label: "Blocks that can stay for good, and deletions that stay home",
    changes: [
      "A temporary block can now be made permanent without retyping anything. Automatic blocks expire on their own — the right default for the random noise of the internet — but when the same address keeps coming back, the Blocked IPs page now offers an ∞ button on any block that would expire: one confirmation and it stays until you remove it. The block keeps its history — the reason still says what was counted and when — and it works on an already-expired row too, re-arming it on the spot.",
      "The app can now ask the internet's opinion of an address it has already caught. Paste a free AbuseIPDB key under Security → Policies and every address that trips the auto-block is looked up against their community abuse database, its confidence score shown right on the Blocked IPs page — \"100% abuse confidence · 4,213 reports\" turns a cryptic row into an obvious decision — with a button to check any blocked address on demand. If the score crosses a threshold you control (90 out of 100, unless you say otherwise), the automatic block simply keeps no expiry: a known-abusive address doesn't get a second visit an hour later. This is off until you add a key, only addresses the app already flagged are ever sent anywhere, answers are remembered for a day, and your own manual decisions are never rewritten.",
      "A new policy keeps deletions at home: switch on \"Allow deletions only from trusted networks\" and deleting anything — items, files, emptying the Recycle Bin, clearing duplicates, restoring a backup over the live database — is refused from outside the networks you trust, for every account, admins included. The point is what a stolen password can no longer do from the internet: browse, listen, upload, edit, yes — destroy the library, no. Signing out a suspicious device or revoking a token still works from anywhere, because those protect the account rather than endanger it. Off by default; the page warns you if you switch it on with no trusted networks defined.",
      "The scanner sweeps every internet-facing server sees are answered more curtly. The list of probe paths that get a bare 404 — and count toward blocking their sender — now also covers requests for YAML configuration, private key files, credential JSON, GraphQL endpoints, and web-server status pages, none of which this app has ever served. And an unknown API address now answers with a proper \"not found\" instead of politely handing the whole app shell to whoever asked.",
      "The two-factor and control-panel guides describe the new switches, and the control panel's search finds them under words like \"permanent\", \"reputation\", \"abuseipdb\" or \"deletion protection\"."
    ]
  },
  {
    version: "3.8.1",
    label: "A blocked visitor gets a real page, and expired blocks say so",
    changes: [
      "A browser opening the app from a blocked address used to be shown the refusal as raw JSON on a white page. It now gets a small page that says what happened in words: the network is blocked after repeated failed sign-ins or suspicious requests, automatic blocks expire on their own, and a member of the household can wait, switch networks, or ask their administrator. It deliberately says no more than that — not why or for how long, which stays in the admin's event log and email. The app itself and other API callers still get the JSON they can show inline, so the sign-in form's error message is unchanged.",
      "An automatic block that has run out its cooldown stays in the Blocked IPs list — only its enforcement stops — and it used to sit there looking exactly like an active block unless you read the date closely. Expired rows now wear an Expired badge, judged by the same clock the enforcement uses, and their remove button says what it now does: tidy the list, not unblock anyone. The page's description explains the lifecycle outright.",
      "A guessed invite link now counts against its source address the same way guessed share links, reader tokens, and device codes do, feeding the automatic IP block. A used, revoked, or expired invite — a stale link someone in the household legitimately held — still counts for nothing."
    ]
  },
  {
    version: "3.8.0",
    label: "A second factor from outside, and blocks that say what they counted",
    changes: [
      "A new security policy — Control panel → Security → Policies → Two-factor sign-in — makes a password alone not enough to sign in from outside your trusted networks. Accounts with two-factor set up are asked for their usual code; accounts without get a one-time code emailed to their sign-in address, no setup needed. Everything else the app defends with — lockout, rate limits, the IP auto-block — guards against someone guessing a password; this is the wall that still stands when someone shows up with a correct one. At home, on a trusted network, nothing changes, and passkey sign-ins already count as two factors.",
      "The policy plays it straight about its edges. Turning it on lists exactly which accounts have no second factor set up and what will happen to them. If the server can't send email, an account without two-factor is refused from outside — with a message saying to sign in from home and set one up — rather than waved through, because the policy's whole promise is that a password alone is never enough. And behind a reverse proxy with TRUST_PROXY_HOPS unset, where the server can't tell who is inside, it asks everyone for the factor instead of guessing.",
      "When an IP gets automatically blocked, the block now says what it actually counted — \"15 scanner probes and 6 failed sign-ins\" — instead of calling everything a failed sign-in. The reason on the Blocked IPs page, the admin email, and a new entry in the event log all tell the same story, so a block finally shows up in the log at all (it never did before). When no password was ever tried, the email says so outright: an automated scanner sweeping for software you don't run, the kind every internet-facing server sees — the block expires on its own and nothing else is needed.",
      "The two-factor and exposing-to-the-internet guides describe the new policy, and the control panel's search finds it under words like \"mfa\", \"2fa\" or \"require second factor\"."
    ]
  },
  {
    version: "3.7.6",
    label: "Book actions move up top, and tags become tinted pills",
    changes: [
      "Everything you can do to a book or ebook — favorite it, edit its details, download it, send it to an e-reader, add it to a collection, share it, delete it — now sits in one row at the top of its page, right beside Back, instead of mid-page under the description. It's the arrangement an open album in the Gallery has always had, so every \"one thing open\" page now reads alike: Back on the left, the thing's actions beside it. Start listening and Read stay big and by the cover — the action you came for doesn't hide among the housekeeping.",
      "Those buttons now also look like the Gallery's: one square icon-button style everywhere, replacing the round pills the book and family pages carried. Nothing lost in the translation — a favorited book still fills its heart in rose, a book saved for offline still shows mint.",
      "A book's category and tags under the cover are now small tinted pills — gold for the category, mint for tags — instead of the gray boxes they were, and they've stopped pretending every name is short: an overlong tag is cut with an ellipsis, and pointing at it shows the full name."
    ]
  },
  {
    version: "3.7.5",
    label: "Search folders by name, and catch a folder copied into itself",
    changes: [
      "Searching in the gallery's Folders view now searches folder names, and stays in Folders. Typing there used to jump you into the Timeline and search the photos — an answer to a question nobody standing in a folder tree was asking. The search covers the whole tree, not just the level on screen, so a folder buried years deep is findable by name alone; results show where each folder sits and how much it holds, and clicking one opens it. The Timeline still searches photos, and filters still take you there — a folder tree can't show \"only videos from 2019\".",
      "Duplicate cleanup now catches a folder copied into its own parent. The commonest sync-client mess — a folder holding a copy of itself, the two differing by a stray frame or two — produced no folder answer at all: the identical tier can't pair a folder with its parent, the stored-elsewhere tier needs every last photo covered, and the overlap tier skipped nested pairs on the assumption the other two had it. Now it appears as an overlap: only the shared copies leave one side, and the stray each side holds alone survives. Re-run the scan on an open cleanup to see them.",
      "The cleanup's results can be sorted — Largest first, as always, or Most copies first, which surfaces the sets with the most files to clear even when they reclaim little space. The order applies within each section, so folders still come before files and certain before uncertain.",
      "A photo's details now name the library it belongs to, under the folder. The folder alone can't say which copy you're looking at when two libraries carry the same folder shapes — and if you're using duplicate cleanup, yours do."
    ]
  },
  {
    version: "3.7.4",
    label: "See and change where deleted files go, from the Recycle Bin itself",
    changes: [
      "The Recycle Bin's location — one shared folder, or each library's own hidden .trash — could only be seen and changed from Library → Storage, which nobody standing in the bin thinks to visit. The bin now says it itself: an empty bin states where deleted files will go, and the bin's settings (the gear by the search box) show the location alongside the retention clocks, with a Change location button right there. Same rules as before — the location only changes while the bin is empty, and nothing already deleted ever moves.",
      "It is the same editor in both places, not a copy: the folder picker still offers only folders the server can actually reach, and the guidance about keeping the bin on the same disk as your libraries reads identically whichever page you came from. The control panel's search now also finds the location setting from words like \"recycle bin folder\" or \"bin path\"."
    ]
  },
  {
    version: "3.7.3",
    label: "Backups carry your covers again, and duplicate cleanup stops guessing wrong",
    changes: [
      "Backups were quietly leaving out every cover if your thumbnail store was set in the app (Control panel → Library → Storage) rather than through the THUMBNAIL_PATH environment variable — the backup page read only the environment, said \"no thumbnail path configured\" while one was plainly configured, and still labelled the result \"Full (DB + covers)\". It now reads the same setting everything else does, backs up the covers from where they actually are, and restores them to where the app will actually look. If your Storage page names a custom path, check one backup made after this update — earlier \"full\" backups from such a setup carry no covers.",
      "Duplicate cleanup no longer proposes deleting the only good copy of a photo. Film scanners write a low-resolution index scan beside each full-size frame and stamp the camera model on the index scan only, so judged on metadata the thumbnail won — and the app suggested keeping a 147 KB preview over the 1.4 MB photograph it came from. A copy holding under a quarter of the pixels of the best in its set now loses to it no matter what metadata it carries, because pixels are the one thing no other copy can give back; the camera info and date follow the surviving photo instead of vanishing with the preview. Re-run the scan on an open cleanup to get the corrected choices.",
      "Every result in a cleanup now wears a little dial, from green to red: how carefully to look before letting it through. Byte-identical copies read \"No risk\" — whichever is kept, the picture is exactly the same. Copies that merely look alike climb to \"Low risk\", \"Worth a look\" or \"Check first\", depending on whether anything you did — tags, albums, folder rules — stood behind the choice, and on how much the pictures can be trusted to be the same shot. The full sentence behind the reading is on the dial's tooltip.",
      "Each copy on a card now shows its file size and pixel dimensions — on identical sets too, where the sameness of the numbers is the reassurance. Where one copy is a fraction of the biggest, its tile says so outright (\"8× smaller\"): a quiet note on a copy being deleted, a red warning on one being kept. And if your own clicks would delete a copy much larger than the one being kept, the card says that in words before you do it — pixels can't be got back.",
      "Also fixed: the backup page's note about a missing thumbnail store now links to the Storage page instead of misreporting the situation, and a \"Kept on a guess\" badge stays honest — a keeper chosen because the other copy was a low-resolution preview is reported as the guess it is, not as your own decision."
    ]
  },
  {
    version: "3.7.2",
    label: "Restore just the database, and find out why a sign-in really failed",
    changes: [
      "Restoring a backup now asks whether to put the cover art back as well. It's on by default, exactly as before. Turning it off restores only the database and leaves the covers you have alone — quicker, since on a full backup the covers are most of the archive, and usually what you want, because the cache on disk is generally holding the same art the backup is carrying.",
      "A failed sign-in now says in the activity log why it failed: a wrong password, an address with no account behind it, a deleted account, or a deactivated one. A mistyped email and a wrong password used to read exactly alike, and they behave nothing alike — the lockout counts against the address that was typed, so one transposed letter locks out an email that appears nowhere in your user list, while the real account sits there unlocked, apparently refusing a password that is perfectly correct. The sign-in screen still says only \"Invalid email or password\": this is for the log, which only administrators can read.",
      "For the same reason, the email you're sent when an address is locked out now tells you when that address has no account at all — nothing of yours is locked, and the likeliest explanation is someone in the house typing their own email slightly wrong."
    ]
  },
  {
    version: "3.7.1",
    label: "Restore a backup bigger than 2 GB, and get a locked-out account back",
    changes: [
      "Restoring a full backup larger than 2 GB failed outright, with \"File size … is greater than 2 GiB\" — and a backup that carries your covers passes 2 GB quickly, so this hit the backups most worth having. The archive is now read a piece at a time instead of being loaded whole into memory, and its size no longer decides whether it can be restored. Uploading a backup from your computer had the same ceiling and no longer does.",
      "Deleting an account used to keep its email address for itself. Creating a new account with that address answered \"An account with this email already exists\" while no such account was anywhere on the page — an argument with something invisible, and no way out of it. The address is accepted now: the new account takes the deleted one's place, so anything it still owns, like a library or a collection, comes with it, and its old two-factor setup and passkeys are removed, since only the new password is meant to open it. You're told when that happens.",
      "\"Clear sign-in lockout\" is no longer greyed out. Whether an account is locked is worked out from its recent failed sign-ins each time the user list loads, so the answer went stale while you were reading it — and the one action that could help was disabled exactly when it was needed. It's always available now, and clearing a lockout that isn't there costs nothing.",
      "Giving someone a new password now clears their lockout too. A new password is no use to someone the server is still refusing, and waiting out the lock reads as the reset having failed. Deleting an account clears it as well: failed sign-ins are counted against the email address rather than the account, so a lock could otherwise outlive the account and meet whoever was given that address next."
    ]
  },
  {
    version: "3.7.0",
    label: "Set how big your photos are, and reach the rest of the gallery from anywhere in it",
    changes: [
      "The gallery has a View button now, next to Filter and Sort. Tile size — Small, Medium or Large — decides how much of a year fits on screen at once: small for hunting through it, large for actually looking at the photos. It applies to the timeline and to an open folder, and it is remembered, so it is a decision you make once rather than every visit.",
      "The same menu turns the date headings off. Group by day is still how the timeline arrives; One continuous grid runs every photo together as a single wall, which reads better when you are scrolling for a picture rather than for a date. Picking several still works there — use Select in the toolbar, since there are no day headings to tick.",
      "On a phone, the Browse menu now sits beside the search box on every gallery view: Timeline, Memories, Albums, Slideshows, Folders, People and Map. It used to ride the toolbar, which People has none of, so that one view had no way of reaching any of the others.",
      "Also on a phone, a Back button is now the arrow on its own. \"Back to slideshows\" is more words than a 375-pixel row has to spare, and it was crowding out the controls it shares that line with. It still says where it goes when a screen reader reads it out."
    ]
  },
  {
    version: "3.6.1",
    label: "Choose how long remote linking stays open, and a tidier user list",
    changes: [
      "Allowing someone to link a device from outside now asks how long for — anything from 1 to 60 minutes, still defaulting to the hour. If you're on the phone with them while they set the screen up, five minutes is plenty and leaves nothing open behind you. It still ends the moment they link a device.",
      "The user list under Members has been cleaned up. Each account's seven action buttons — a row of unlabelled icons whose meaning lived in tooltips — are now one ⋮ menu where every action is written out, and an action you can't use says why (\"This user has no passkeys\"). Rows are about half as tall as a result: names, badges and email no longer wrap onto three lines each, and the space the buttons were holding went back to the name column, which had been truncating.",
      "The row menu also opens properly now. It used to be cut off by the edge of the table it lived in; it escapes the grid entirely, flips above the row when there's no space below, and follows the row if you scroll while it's open."
    ]
  },
  {
    version: "3.6.0",
    label: "Let one person link one device from outside the house, for one hour",
    changes: [
      "Linking a TV or display has always been refused from outside your home network — the setting that allowed it was all-or-nothing, permanently, for everybody. There's a better way now: from Control panel → Members → Users, allow a single person to link a single device from anywhere, for one hour. Their row shows how long is left and cancels it with the same button, and it closes itself as soon as they link something. Grant it as often as you need; each grant is worth one device.",
      "Away from home with nothing open, the sign-in screen simply doesn't offer to link a device any more, instead of offering it and refusing. Approving still takes the person's own password, the device still can't reach the control panel or authorize other devices, and you're emailed when a window you opened gets used.",
      "If your server sits behind a reverse proxy with TRUST_PROXY_HOPS unset, every visitor looks like it's on your home network — so device linking refuses everything in that state rather than treating the internet as your living room. An open window is an explicit decision that location doesn't matter for the next hour, so it goes through anyway."
    ]
  },
  {
    version: "3.5.0",
    label: "Sign a TV in by scanning a code, instead of typing a password with a remote",
    changes: [
      "A television, wall display or kiosk can now be signed in without typing anything on it. The screen shows a QR code and a short code; you scan it with your phone, check the code matches, enter your password, and the screen signs itself in. Your phone must be on the same network as the server — it says so on the screen, because that's the one thing that otherwise fails silently.",
      "Linked screens are deliberately less powerful than the account behind them: a linked display can't open the control panel even when the account is an administrator's, and it can't authorize further devices. It stays signed in for a year rather than a fortnight, because a wall display that logs itself out every two weeks needs a human with a remote control — the exact chore this removes.",
      "Profile → Devices is now a real list of everywhere your account is signed in. Linked screens sit at the top with the date they were linked and where they were last used; rename one, or revoke it and it's signed out on its next request. Your ordinary browser sign-ins are in the same list, folded away, and can be signed out the same way. You're emailed whenever a device is linked to your account.",
      "By default only devices on your home network can ask to be linked, which is what stops someone elsewhere from starting a request and talking a household member into approving it. Admins can widen that under Control panel → Security → Policies. If the server sits behind a reverse proxy with TRUST_PROXY_HOPS unset, every visitor looks local — so linking refuses entirely until that's set, rather than quietly treating the whole internet as your living room."
    ]
  },
  {
    version: "3.4.3",
    label: "Every open album, slideshow and person looks and works the same way now",
    changes: [
      "Opening an album, a slideshow or a person now shows the same thing: a compact row of icons — Back plus every action, no page title or toolbar competing for space — above a cover, a name, and a count. Rename sits right next to the name instead of hiding in the row. All three can also have their cover photo set by hand now, including people (pick one of their photos and it also picks the sharpest matching face crop from it), not just albums and slideshows.",
      "Slideshows now leads with what you might create — suggested slideshows sit above your own, capped to one scrollable row instead of a wall of tiles, and it scrolls sideways in the app too. The explanatory paragraphs under both sections are gone; the sections speak for themselves.",
      "People dropped its Filter/Upload row and the \"Face recognition\" button — turning it on, rescanning, or clearing a library's face data all happen from Control Panel → Libraries now, which already had the same controls."
    ]
  },
  {
    version: "3.4.2",
    label: "Gallery's library picker moved into Filter too",
    changes: [
      "Gallery's own library dropdown is gone — which libraries a view draws from is a Filter facet now, the same as Audiobooks and Ebooks, and it's multi-select: narrow to two libraries and see both at once instead of one at a time. Timeline, Folders, Memories, People and Map all gained it; Albums and Slideshows never scoped by library in the first place, so they're unchanged. Folders' rescan still needs exactly one library, so its button now appears only when the filter narrows to a single one."
    ]
  },
  {
    version: "3.4.1",
    label: "An open album shows what it can do in one place instead of three",
    changes: [
      "Opening an album used to show its own breadcrumb, its own three-dot menu, and its own Sort and Select buttons, sitting apart from the toolbar and styled differently from it — three places carrying what one album lets you do. It's one row now: Sort, then Slideshow and Share (what you reach for most), then an \"Album\" menu holding Rename, Set cover photo, Download and Delete, then Select — the same shape as every other page's toolbar. The breadcrumb is gone; \"Back to albums\" in the toolbar already said where you were."
    ]
  },
  {
    version: "3.4.0",
    label: "One toolbar for Audiobooks, Ebooks and Gallery, and an A–Z that reads Cyrillic",
    changes: [
      "Audiobooks, Ebooks and Gallery now share one toolbar instead of three near-identical copies of the same row. Filter, Sort and View say what they're doing rather than making you open them to find out — Sort shows the order the list is actually in, Filter shows how many things are narrowed, and a divider separates what changes the view from what acts on it (Select, Upload, and each page's own tools). Selecting books or photos swaps that row in place instead of pushing a second bar under it, and the card stays pinned while you work. On a phone, the row drops its labels down to icons and Gallery's eleven-verb selection does the same a little earlier, so nothing ever runs off the edge of the screen.",
      "Choosing which library to browse moved into Filter on Audiobooks and Ebooks, and it's no longer one-or-all: pick two libraries and the list shows both, narrowing within what you can already see rather than a separate picker bolted on the side. Gallery keeps its own picker for now — a folder tree and a rescan still mean one library at a time.",
      "An A–Z strip sits under the toolbar on Audiobooks, Ebooks, Authors, Narrators and Series, and it understands more than the alphabet it was built with: a library mixing Latin and Cyrillic titles gets an English/Русский switch, each showing only the letters something is actually filed under. Getting there meant fixing how those titles sort in the first place — Ё used to sort above А by raw character code, so a shelf of Cyrillic titles opened in the wrong order without anyone touching the alphabet strip at all.",
      "The Recycle Bin users' Actions column now fits every action without a horizontal scrollbar — it was sized for five buttons after a sixth joined the row. Session timestamps in Members do the same: the date and time now sit on two short lines instead of one that didn't fit."
    ]
  },
  {
    version: "3.3.3",
    label: "A network that blocks the app now says so, instead of looking like a failed sign-in",
    changes: [
      "Sign in from an office, school, hotel or airport network and it can fail for a reason that has nothing to do with your password or your server. Those networks run a security gateway that inspects every request, and a home server's domain is usually filed as \"uncategorised\" — which some gateways block outright, answering the browser themselves with their own refusal page. The page still loads, because it comes from the browser's cache, and only the calls to the server are stopped, so the app looked broken and the sign-in looked wrong. It is recognised now: the sign-in screen says the network is blocking it and names the address to allow, and the small pill at the top reads \"Blocked by this network\" rather than \"Server not responding\". Nothing changes on the server — the request never reaches it. The new section at the end of the Exposing your library to the internet guide covers what to do about it, including how to get the domain reclassified.",
      "A blocked request no longer hides what you have already downloaded. Downloaded books and photos are kept for exactly this, but a gateway's refusal used to read as the server saying no, and the app would show the refusal instead of the copy sitting on the device.",
      "Every sign-in screen now shows which version it is running, under the panel — the sign-in form, the two-factor step, an invite, and first-run setup. When one device is behaving differently from another, this is the first thing worth comparing, and until now you had to sign in to find it."
    ]
  },
  {
    version: "3.3.2",
    label: "A memory dated a couple of days out no longer goes missing",
    changes: [
      "Memories stops losing a year because its photos are dated a day or two off. It looked for photos taken on exactly today's date, and only if it found none in any year at all would it widen to within three days — so a single year matching the date exactly was enough to stop every other year from ever being looked for. The photos that suffer are the old ones: a scan carries the date written on the sleeve, or the day it was scanned, rather than the moment the shutter went. Every year is now judged on its own. A year with photos on the day shows those; a year that is merely close shows those and says \"Around August 11\" rather than claiming the day itself, and the row is still titled by its best match. On one library this turned an August 11 that had been showing 16 photos from a single year into 32 from three.",
      "The Gallery's search box now appears only where it searches something. It sat on all seven views but worked on just the Timeline and Folders, so on Albums, Slideshows, People, Memories and the Map it quietly swallowed whatever you typed. It is gone from Memories and the Map, which have nothing to search, and on Albums, Slideshows and People it now filters that list by name as you type. Filter and Sort follow the same rule and appear only where there are photos for them to narrow. What you type no longer follows you from one view to the next, because the same box means a different thing in each."
    ]
  },
  {
    version: "3.3.1",
    label: "Filter and sort moved down beside the library they narrow",
    changes: [
      "On the main Audiobooks, Ebooks and Gallery pages, the filter, sort and Select buttons have left the row carrying the page title and joined the strip below it — the one holding the library picker. They narrow whatever that picker has chosen, and they were sitting a row away from it. Upload stayed where it was: it adds to a library rather than choosing among what is already in one. None of them do anything different, and on a phone the strip wraps so they sit under the picker rather than squeezing in beside it.",
      "The Gallery's Play button has gone from that strip. Playing a set of photos is now offered where there is a set to play — inside an album, and on a saved slideshow — rather than from a button carried by every screen. It also means the Timeline, a folder and Memories no longer offer to play themselves; open an album or a slideshow to do that."
    ]
  },
  {
    version: "3.3.0",
    label: "A menu of its own for each part of the library, and one header on every page",
    changes: [
      "Each part of the library keeps its own menu now. Open Audiobooks, Ebooks, the Gallery or the Family Tree and the list down the left becomes that section's: Authors, Series, Narrators and Categories under the book sections; Timeline, Memories, Albums, Slideshows, Folders, People and Map under the Gallery; the chart, everyone in it, and the family names they are grouped under, under the Family Tree. Home stays at the top of every one of them, with Settings and your profile at the foot, so nothing is further away than it was. The rows of tabs these pages used to carry across the top are gone — they said the same thing from a place that was competing with the search box and the filters beside it.",
      "Every view in the Gallery is a page you can link to. Albums, Slideshows, Folders, People, the Map and Memories each have an address of their own, so one can be bookmarked, opened in a new tab, or sent to someone — and the browser's Back button steps between them the way it does everywhere else, instead of dropping you out of the Gallery altogether. Until now they were all the same address wearing different contents, which is why none of that worked.",
      "Every browse page wears the same header. The search box used to change size and place depending on which page you were on — large and beside the title on the main Audiobooks and Ebooks pages, small and below it on Authors, Narrators and Series — and the button that creates something turned up in three different spots. It is one arrangement on all of them now: the page's name and count on the left, then search, filters, sort, and last the one Create button. Categories gained a search it never had, and the Gallery's views name themselves at the top of the page rather than all calling themselves Gallery.",
      "Following a person out of a section and back no longer loses your place in it. Opening an author from the Ebooks list used to drop you into a page wearing the main menu, and coming back left you somewhere subtly different from where you started; the person's page now keeps the section's own menu, and Back returns you to the list you left.",
      "The Family Tree has a menu of its own for the first time. Its three pages — the chart, everyone in it, and the family names — could already reach one another, but only through links tucked into each page's header with a \"Back to the tree\" above them. They are one list on the left now, and a person's profile and their photos keep it on screen instead of falling back to the main menu."
    ]
  },
  {
    version: "3.2.0",
    label: "Give the movie's opening card your own words and a photo behind them",
    changes: [
      "The card a slideshow movie opens on is yours to write. Until now it was one fixed thing — the slideshow's name and how many photos were in it, white on black, for three seconds — and there was nothing to change about it. Open a slideshow and you will find Title card beside Music: whether the movie opens on a card at all, what it says, what the second line says (the photo count as before, a line of your own such as a place and a month, or nothing), and how long it stays before the first photo arrives.",
      "It no longer has to sit on black. The card can sit on one of the slideshow's own photos, on that photo blurred so it reads as colour and light rather than a picture competing with your title, or on a collage tiled from a dozen of them, taken from across the whole slideshow rather than off the front of it. Where you pick a single photo, every slide is offered as a thumbnail to choose from. Whatever is behind the words is darkened and the letters are given a dark edge, so a title still reads over a bright sky.",
      "You are shown the card as you build it. The panel draws the real thing — the same picture the movie will open with, only smaller — and redraws it as you change anything, because choosing a background you cannot see is guesswork. Videos cannot be used behind a title: a photo is a picture already, while a film has to be unpacked to find one, so slideshows made only of videos keep the black card.",
      "Slideshows you already have are untouched and will render exactly the movie they rendered before: every one of these settings starts out as the card the last version drew."
    ]
  },
  {
    version: "3.1.2",
    label: "A limit of its own on the one address strangers can reach",
    changes: [
      "The single address that answers without being signed in — the one the app asks, before anything else, whether the server is there and whether it has been set up yet — now has a request limit of its own. Everything else reachable without an account already had one; this was relying on the server-wide ceiling instead, which is a much larger number and shared with all your ordinary browsing. Nobody will notice the difference: the allowance is set well above what a houseful of open tabs asks for, and the app leans on that same address every few seconds to tell the difference between the server being down and your phone having no signal — which is what the little Offline marker is reading when it appears."
    ]
  },
  {
    version: "3.1.1",
    label: "Add a folder of slideshow music in one go",
    changes: [
      "Slideshow music takes several files at once. The picker used to accept one track per visit, so putting a handful of beds on the server meant opening the dialog, choosing, waiting, and starting again. Select as many as you like and they go up together. If a name is already in your list it is left alone rather than added a second time — the picker lists tracks by name, so a duplicate would be two rows you could not tell apart, and that holds whether the copy is spelled differently or is simply the same piece in another format. Nothing is refused for it: choosing a folder where three of five are already there adds the other two and tells you which it skipped.",
      "The Recycle Bin's settings button no longer disappears when the bin is empty. It sat in the row of controls above the deleted items, and that row is only drawn when there is something to act on — so the one setting that is not about any particular item, how long things are kept, went with the last item you restored. It now sits beside the search box at the top of the page, where it stays put."
    ]
  },
  {
    version: "3.1.0",
    label: "Sign in with a fingerprint, and mail that looks like it came from somewhere",
    changes: [
      "You can sign in with a passkey — your fingerprint, your face, or the PIN you unlock your phone with — instead of typing a password. Add one under Profile, then Security, and from then on the sign-in screen has a button that asks your device instead of asking you. There is no email to type: your phone already knows which account it holds. Nothing about the passkey leaves the device, so there is no password to steal, and it only works on the real address of your library, so a convincing fake page cannot borrow it. If you use two-factor, a passkey does not ask for a code on top: your device checked it was you before it would sign anything, which is the same two things the code was there to establish. Your password and your codes carry on working exactly as before, and they are how you get back in if you lose every device. Passkeys need the library to be reached over https at a domain name — on a home network reached by its address on the network, browsers do not allow them at all, and the panel says so rather than offering a button that could not work.",
      "An administrator can remove someone's passkeys from the control panel, under Members, for the case where every device that held one is gone. It leaves their password and two-factor untouched; they sign in the old way and add a new one.",
      "Every email the server sends has been rewritten to one house style — sign-in codes, security alerts, the note that something was shared with you, a book sent to your e-reader. Each is now written once and sent as both a formatted message and a plain-text one, so what arrives in a mail app that refuses formatting says the same thing rather than something that drifted apart from it years ago. They carry no images loaded from the server, which means nothing to load and nothing that reports back when you open them.",
      "The switch for whether the server may email members about routine goings-on has moved out of the email settings and into a Notifications page of its own, under Settings. Whether mail can be sent and whether it should be are different questions, and an administrator who set up a mail server so that security alerts would arrive had not thereby agreed to email five family members about everyday activity. Everything on the new page starts off, and the page explains itself where there is no mail server to send through.",
      "In the duplicate cleanup wizard, the folders you can leave instructions on are listed biggest first. An instruction on a folder of four photos settles almost nothing and there are usually hundreds of those, while the handful holding thousands are where choosing which copy to keep actually decides something — so those are at the top now instead of wherever the folder path happened to put them. The paragraph that used to sit above the list, explaining that instructions belong to this cleanup alone and that Clear never empties a folder, is now an i beside the heading: there to read the first time through, out of the way afterwards."
    ]
  },
  {
    version: "3.0.8",
    label: "Told when something is shared with you, and an A to Z for the authors",
    changes: [
      "When someone shares a photo, a book or an album with you, you are sent an email about it. Until now it simply appeared under Shared with me and you found it whenever you next happened to look, which in a quiet week could be never. The message says who shared what, and when your access runs out if it ever does. It carries no photo and no file, so it is still your account that opens them. Sharing thirty photos at once is one message rather than thirty, and sharing something again with someone who already has it says nothing at all. An administrator can switch the whole thing off under Settings, then Email.",
      "The Authors page has an A to Z along the top, and a choice between filing people by their first name or their last. Choosing Last name puts Ursula K. Le Guin under G and orders the page by surname. Letters nobody is filed under go quiet rather than disappearing, so the row does not shuffle about underneath you as you narrow things down, and there is a library filter too where you have more than one.",
      "Moving between pages no longer flashes the sign-in screen at you. Each page is fetched the first time you open it, and while that was happening the app drew the same background it uses to ask for your password — for a fraction of a second, but often enough to look as though you had been signed out. The page you are on now stays put until the next one is ready. Reloading is the same story: the app appears straight away rather than passing through the sign-in scene on its way.",
      "The list of users in the control panel no longer slides sideways. The five buttons at the end of each row needed more room than the column had, so they hung over the edge and dragged a scrollbar in with them, and the date each person joined was being cut off part-way through for the same reason. On a narrower window the list now sets a column aside at a time rather than becoming something you scroll.",
      "In the duplicate cleanup wizard the library switches line up in a straight column. A padlock appeared only on libraries the app may just read, and simply having one nudged everything on that row out of step with the rows above it. Every library shows one now: closed where files can only be compared, open where they can be cleaned. The wizard is four steps rather than three as well, with what to compare on a page of its own instead of sharing the first one with the library list."
    ]
  },
  {
    version: "3.0.7",
    label: "One drawing on the empty family tree, not two",
    changes: [
      "The badge on the Family Tree page, before anyone has been added, is a single figure again. A small tree was being drawn behind it, and at that size the two ran into one another rather than combining: the head sat on the branch above and merged with the dots either side of it into a row of circles, and the line below came up through the shoulders. The page already draws the branches and the waiting relatives around the badge, so the badge is simply the person it is asking you to add."
    ]
  },
  {
    version: "3.0.6",
    label: "Opens faster, and stops sending things you never see",
    changes: [
      "Signing in used to download the whole application first — the control panel, the family tree, the gallery and the reader — before it could draw the password field. Each screen now arrives when you first open it and is kept from then on, so the opening page is about a third of what it was to fetch. Nothing looks different; there is simply much less of it before anything appears.",
      "The pictures the app ships with are a fiftieth of the size. The category artwork was full-size photographs being drawn into a space the size of a postage stamp, and there were sixty-nine megabytes of that sort of thing altogether, now three and a half. Nine background scenes that no screen has referred to for some time are gone as well. The artwork on screen is unchanged — this is the same pictures, stored sensibly.",
      "Everything the server sends as text is compressed on the way out: catalogue pages, settings, the status figures. On a phone away from the house, or a home network busy with a scan, that is typically twenty to thirty times fewer bytes for the same page.",
      "The What's new list you are reading no longer arrives in full every time you open About. Two hundred releases had accumulated, and all of them were fetched to show you the handful at the top; now the newest ten come with the page and the rest follow when you ask for them.",
      "Beneath all of that, a good deal of housekeeping with nothing to show for itself: the largest files in the project split up by subject, rules that no longer style anything removed, and the beginnings of a test suite for the interface to sit alongside the one the server already had. None of it changes what the app does, and all of it makes the next change safer to make."
    ]
  },
  {
    version: "3.0.5",
    label: "A Recycle Bin you can search, and backups from the start",
    changes: [
      "The Recycle Bin has a search box, and it looks across names, folders and libraries — so \"that holiday one\" or \"it was in Downloads\" both find it. Sorting is a named menu now rather than an unlabelled icon, which is why nobody could find the five orderings that were already there.",
      "You can also narrow the bin by how long its items are kept. The choices come from the items themselves rather than a fixed list, and each row is measured from its own dates — so a set kept for 180 days by a duplicate cleanup is told apart from one kept for 30 by hand, whatever the settings say today.",
      "How long things are kept has moved into a Settings dialog on the page, and per page, order and retention into a view one. Items removed by a duplicate cleanup are now badged \"duplicate\" rather than \"cleanup\": what the file was, rather than which page took it.",
      "The setup guide can turn on nightly backups. It sits beside the Recycle Bin step, because both are about getting something back after it has gone — and both are worth answering before there is anything to lose. As with every step there, it writes the same setting Maintenance → Backup does, so it can be changed or undone afterwards."
    ]
  },
  {
    version: "3.0.4",
    label: "See the copies, and say which ones stay",
    changes: [
      "A set of identical files shows the photographs now, not a list of paths. Click one to move it between keep and delete — the choice the scan could only guess at. Keep all of them, keep two of five, or keep none; one click changes one copy and leaves the rest alone. The full-size Compare view works the same way.",
      "Keeping nothing is allowed, and it means what it says: the picture leaves your library rather than just its spare copies. The card tells you so, and the \"delete identical copies\" button skips such a set — that button promises every copy it removes has a survivor somewhere, and taking the last one belongs on the card where you can see the decision.",
      "Copies hold their place when you click them. They used to jump to the front of the row when kept and to the back when not, and the card itself moved too, so the next click could land on a set you had never looked at.",
      "A folder pair sits side by side again instead of one above the other, shrinking to fit where the card is narrow.",
      "Comparing two folders is paged rather than building every row at once, which is what that view is for on the big folders. The panel also uses its full height now, and the second Close button at the bottom is gone — the one in the corner was always there.",
      "On Settings → Overview, the database backup command no longer breaks across two lines mid-command, and the near-identical warning on the cleanup page is no longer cut off before it finishes telling you to look before deleting."
    ]
  },
  {
    version: "3.0.3",
    label: "Clear out means clear out",
    changes: [
      "A folder you marked \"clear out\" is no longer kept. It was being named as the safe home for other folders — \"delete these, the copies are in OneDrive\" about the very folder you had asked to empty — and on a real library that was half the results. Clearing a folder now decides the direction: its copies are the ones offered for removal.",
      "Two things were wrong underneath. The instruction only broke ties when choosing which copy survives, so where a cleared folder was the ONLY other copy it was chosen anyway; it is now ruled out entirely, and a folder covered only by a folder being cleared is simply not called redundant. And folders were claimed for removal deepest-first, so a shallow folder like OneDrive lost every race to the dated folders it duplicated and ended up as their survivor. Cleared folders now go first.",
      "A folder holding photos that exist nowhere else still cannot be removed whole — it is offered as a partial overlap instead, so its shared copies go and the ones only it has stay. Re-scan an existing cleanup to pick this up; the results it already holds were worked out under the old rule."
    ]
  },
  {
    version: "3.0.2",
    label: "The setup guide lets you leave",
    changes: [
      "Skip for now and Finish work. Both did save your answer — and then walked you straight back to the guide, because the page navigated away on its own while the app still believed the guide was owed to you. The round trip took a moment, so what you saw was a button doing nothing.",
      "Either button now leaves even when the server refuses to record it. Trapping somebody on a page whose whole purpose is letting them out was the wrong way to fail; when the answer cannot be saved, the guide simply offers itself once more at the next sign-in.",
      "The password on the guide's email step is sent now. It was collected and quietly dropped, so a mail server that needs one could be set up from Settings → Email but never from the guide."
    ]
  },
  {
    version: "3.0.1",
    label: "A setup guide on first sign-in, and folders you browse to",
    changes: [
      "A setup guide now opens the first time an administrator signs in: storage, the Recycle Bin location, email, sign-in alerts and the default theme, in the order they depend on each other. Two steps stay locked until the one they need is done — the bin has to live inside a container you have approved, and an alert with no mail server behind it reads as nothing having happened.",
      "It writes through the same settings pages you would use by hand, so nothing in it is your only chance to answer something. Skipping closes it for good rather than asking again at every sign-in, and Settings → About opens it whenever you want it back.",
      "Folders are browsed rather than typed now — the Recycle Bin location and a library source alike. Both have to be the path the server sees, which under Docker is the path inside the container rather than the host path you know, and both have to already exist. Getting either wrong produced a bare \"that folder is missing or not accessible\", which was true and no help at all; a picker can only offer folders the server can actually reach.",
    ]
  },
  {
    version: "3.0.0",
    label: "One page for duplicates, a Recycle Bin you can place and time — and a fresh start",
    changes: [
      "3.0.0 is a new install, not an upgrade. It will not open a 2.x database: start from an empty one. Libraries rescan themselves from the files on disk, so what you lose is what was only ever in the database — reading progress, bookmarks, share links, and the family tree. Export the family tree as GEDCOM first; it is the one thing that cannot be rebuilt from your files.",
      "A new Utilities page: Duplicate cleanup. The same detection as the two pages beside it, held as one saved job instead of a list you happen to be looking at. Choose which libraries to compare, scan once, and work through what it found whenever you like — closing the browser loses nothing, and next week it opens on the same list with the same decisions already made.",
      "A cleanup works on whole folders OR on single files, never both at once. They are different jobs of work — clearing folders is a few decisions about a great many photos, going through single copies is a great many decisions about a few — and mixed into one list neither gets done, with every folder you clear reshuffling the single-file half underneath it. Run a folder cleanup first; what it leaves behind is what a file cleanup is for.",
      "An administrator who does not own the cleanup now has two buttons beside the padlock: Take over, which makes it theirs with everything it found intact, and Cancel. Only one cleanup can be active at a time, so one belonging to somebody who has moved on used to hold that slot with nothing on the page to release it.",
      "One cleanup runs at a time, and it belongs to whoever started it. Another administrator sees it and how far it has got, but cannot change it underneath them; any administrator can finish it, cancel it, or take it over when the person who started it isn't coming back.",
      "A folder already stored elsewhere is now reported one destination at a time: each card compares one folder with one other folder and says plainly \"these 2 photos also sit in 'Holiday 2019'\". Copies are usually scattered — one photo survives here, the next there — so a single folder can produce several cards, and each one stands on its own: every photo it offers has its counterpart in the folder named, so you can act on one and leave the rest.",
      "That replaces a card that named one covering folder for the whole set. When the copies are spread out no single folder covers them except the library's own top folder, which is how this card came to read \"Everything in this library\" with a note about a place called \".\". It was re-worded four times across four releases without being fixed, because the shape of the answer was wrong rather than the wording.",
      "Nothing is taken on trust when you come back. The moment you confirm a deletion every photo is checked against the library as it stands — still there, same size, same contents, same modification date — and so is the copy it was promised to survive in. If anything has moved on, nothing at all is removed and the card says what changed. That covers a photo deleted somewhere else, a file re-saved by an editor, a library turned read-only since the scan, and the Recycle Bin emptied under a promise.",
      "Skipping and dismissing are told apart at last. Skip is a note on this cleanup and the next one offers the folder again; \"Not the same\" is a standing decision no future scan overrules. They used to be one button, so every \"I'll deal with that later\" quietly became \"never show me this again\".",
      "Read-only libraries — external, or with deleting turned off — are compared and never cleaned. A copy kept in one still counts as somewhere the photo survives, so the copies elsewhere can go, and no folder rule can turn that around.",
      "The Duplicate photos and Duplicate folders pages are gone. They were two views of one scan that belonged to nobody: opening either rebuilt it from scratch, which renumbered every row underneath anyone else looking, and nothing you decided survived the next rebuild. Duplicate cleanup does everything they did and remembers what you told it. Every link either of them ever had lands there.",
      "Two things they could do did not come across, on purpose. Picking the keeper of a set by hand is now done by telling the cleanup which folders to favour and letting it work the answer out again — one rule for choosing keepers rather than two that can disagree. And a set is cleared whole rather than copy by copy: the copies in a set are the same picture, so choosing between them individually was a question with no answer.",
      "The weekly duplicate scan is gone too. It existed to keep those pages' list warm; a cleanup reads what it needs when you press Run scan, and only photos that share a size with another photo are ever opened.",
      "A folder tree that was copied whole is one card, not one per level. Copying \"Photos\" to \"Backup\" duplicates every folder inside it too, so a cleanup listed the parents and then every matching subfolder underneath — and clearing the parent left the rest of the cards pointing at folders that had gone with it.",
      "A cleanup now finds everything the two older pages find, and a few things they don't. It fingerprints on its own when you press Run scan — reading only photos that share a file size with another one, so most of a library is skipped — and it reports all five kinds: identical files, near-identical ones, identical folders, a folder already stored elsewhere, and two folders sharing only some photos.",
      "Every set says how sure it is, on two separate measures, because they are different questions. How sure we are these are the same picture: identical file, or how far apart the two fingerprints are. And how sure we are about which copy to keep: a real reason — it's in a folder you said to keep, it has your tags, it's the original rather than the copy — or, when everything about them matches, an admitted coin toss. A set can be certain about the first and a toss-up about the second, and it now says so instead of averaging the two into one number that means neither.",
      "Compare before you delete. A set of copies opens side by side at full size, and two folders open as two scrolling columns, each photo beside the copy it is promised to survive in — with the extras that only one side holds shown as extras rather than quietly paired with something else.",
      "Sets that are byte-for-byte identical can be cleared in one go. Only those: near-identical sets are judgement calls, and the bulk action refuses to touch them however the page is filtered.",
      "Near-identical is much more careful than it was. Two frames from one burst are no longer offered as copies of each other — same camera, seconds apart, consecutive numbers is a pair of photographs, not a duplicate — and two unrelated pictures that merely share a tonal layout are graded 'have a look' rather than 'these match'. When a file's name has gained a suffix, the plain one is now the one kept.",
      "Folder instructions are part of the wizard, and belong to the cleanup. Step 2 lists every folder in the libraries you picked, and each can be set to keep its copies, clear them out, or neither. They start from whatever is saved for the install, then are this cleanup's own — so changing them can't reach into a cleanup someone else is working through. Clearing a folder out never empties it: a photo with no copy anywhere else is nobody's duplicate.",
      "Deleted items now carry their own date. Each one is given its removal date the moment it goes into the Recycle Bin, and keeps it — so shortening how long things are kept applies to what you delete from then on, and can't bring forward the date on something you were promised a month to think about.",
      "And there are two clocks: one for things you delete yourself, and a separate, usually shorter one for what a duplicate cleanup removes. A hand delete is a mistake you might only notice weeks later, while a cleanup can put thousands of files in the bin at once. The bin can be filtered by which is which, so one book you deleted by hand can still be found under a cleanup's thousands of photos.",
      "The Recycle Bin can also live in one folder of your choosing, set on Storage, instead of a hidden .trash inside every library. Anything else reading the same folders — Immich, a backup job, a sync client — indexes that .trash and goes on showing everything you deleted as though it were still there. Best set before you create libraries; afterwards it can only change while the bin is empty, and it wants to be on the same disk, since deleting onto another one copies every byte instead of being an instant rename."
    ]
  },
  {
    version: "2.22.0",
    label: "One folder page, and folders that share only some photos",
    changes: [
      "Duplicate folders and Stored elsewhere were two tabs asking one question about a folder, so you had to check both to answer it. They are one page now, strongest statement first, each kind under its own heading with its own action: identical folders keep one and remove the others, a folder stored elsewhere goes whole. Every address the old tab had still lands here.",
      "A third kind joins them: folders that share only SOME photos. Half a card re-imported into a new folder, a \"best of\" pulled from several trips — neither folder equals or contains the other, so nothing used to report them, though they may share hundreds of identical pictures.",
      "Their action is the narrowest on the page. Only the shared copies on one side go; every photo either folder holds alone stays exactly where it is, and both folders remain. The card says how many photos of its own each side keeps, because \"delete\" beside a folder name otherwise reads as the whole folder going.",
      "Which side keeps follows the same rule everywhere now: a library whose files can't be deleted — external, or with deleting turned off — always keeps, ahead of even the folder instructions you have saved, because proposing to delete from it proposes something that cannot happen. When BOTH folders of a pair are protected, the pair is still shown, since knowing about it is worth something, but no deletion is offered.",
      "What is shared, and which side keeps, are worked out again the moment you confirm — so a library policy or folder instruction changed since the page loaded is honoured rather than ignored.",
      "A pair whose folders are already answered by one of the stronger kinds is never repeated as a weaker one, a folder is never paired with its own parent, and two shared photos is the minimum: one shared photo is a duplicate photo, which the other page already reports.",
      "The pager on the folder page said how many matches there were in total where it meant to say which of them you were looking at. It reads \"Showing 1–10 of 47\" again."
    ]
  },
  {
    version: "2.21.2",
    label: "Every copy says which folder and which library it's in",
    changes: [
      "A copy on Duplicate photos now shows its full folder path and its library, under the filename and size, with the same two icons the folder cards use. It used to show only the folder's last segment — and in a phone backup a name like \"2021-10-20\" or \"SM-G960U\" sits under half a dozen different parents, so the tail on its own told two copies apart from nothing, which is the entire job of that line.",
      "The library is shown even when you have picked one. It used to disappear then, which was reasonable and made the tile change shape depending on the filter above it."
    ]
  },
  {
    version: "2.21.1",
    label: "A library's root is a place, not a folder to clear out",
    changes: [
      "Stored elsewhere could offer a library's own top folder as the thing to remove — a card named \".\", whose link opened a folder full of folders with no photos in it, while the note underneath named the folder the copies were really in. It was proposing to empty an entire library. The rule that hides a folder when its parent is also redundant was doing it: the top folder counts as everyone's parent, so it hid the real folder and stood in its place. A library's top folder no longer hides anything inside it, and is itself offered only when nothing narrower is — which is exactly when it is the honest answer, the photos being loose at the top level.",
      "The same correction on the other side of the card: a library marked \"keep photos here\" no longer drags its top folder ahead of the actual folder the copies sit in. Both sides now name a folder you can go and open.",
      "Folder cards are down to three lines — the folder's name, its full path, and the library it's in, each with a small icon. Size, date added and the tags-and-links count have gone: all true, none of them what you are deciding with, and the card's header already says what the folder holds and what clearing it frees."
    ]
  },
  {
    version: "2.21.0",
    label: "The duplicate pages send a page, not everything they found",
    changes: [
      "All three duplicate tabs asked the server for every result it had ever found and then showed you twenty-five of them. On a large library that is a reply describing tens of thousands of photos, rebuilt every time the page opened and every three seconds while a scan ran. Each tab now asks for the page it is showing, and narrowing, ordering and paging happen where the data is.",
      "That splits the work in two. Deciding WHICH results match and in what order needs a handful of cheap details about each; what a card draws — thumbnails, dimensions, dates, and the counts of tags, albums and people — is needed for the ten or twenty-five on screen. The second kind is now done for those alone. On the folder tabs it is the bigger saving, because the folder a card describes is routinely an entire library.",
      "\"Delete all extras\" still covers exactly the sets your filters leave, and still names every one of them explicitly rather than re-deciding at the moment of deletion: the page asks which sets those are, using the same filters it counted with, and the count you confirm is the count that goes.",
      "Typing in the search box waits a moment before asking, rather than asking on every keystroke.",
      "On Stored elsewhere, a kept folder that is a whole library now says so and gives the library's name, instead of showing \".\" as though the photos were at the top of it. The folders the copies are really in are named underneath, as before."
    ]
  },
  {
    version: "2.20.3",
    label: "Nothing deletes out of an external library, and the duplicate page stops re-asking",
    changes: [
      "An external library is one the app reads and does not own. Its files were safe from every delete button in the app EXCEPT the duplicate finders, which went straight to the Recycle Bin machinery without asking whether the library allowed it — and a set of copies routinely spans libraries, so one protected copy in a set was a live delete button over a file that isn't ours. Every path to a deletion now passes the same check, and a library that is external, or simply has deleting turned off, refuses.",
      "The scan's own suggestion follows suit: where a photo sits in both an ordinary library and one that can't be deleted from, the protected copy is the one kept. It outranks even the folder instructions you've saved, because it isn't a preference — proposing to delete a file the app may not touch is proposing something that cannot happen. Whole folders follow the same rule.",
      "\"Clear out\" is no longer offered for a folder in such a library. It means \"let this folder's copies go\", which is exactly what can't be done there.",
      "The Duplicate photos page was asking the database nine questions about every copy it showed — one per kind of tag, album, collection and so on — and re-reading your saved folder instructions once per copy on top. It now asks each question once for the whole page. The page loads every set it has found, so this was the difference between a page that opens and one that thinks about it for a while."
    ]
  },
  {
    version: "2.20.2",
    label: "Restore all could bring the server to a halt",
    changes: [
      "Restoring in bulk asked for a full library scan for every single photo put back. Each of those walks the whole library, and they run one after another, so restoring a few hundred photos left the server working through a few hundred complete scans and answering nothing else in the meantime. A bulk restore now starts one scan per library, once, when it has finished.",
      "Asking for a scan twice no longer queues it twice. A scan that has not started yet cannot have missed anything a second one would find, so an identical request now joins the one already waiting instead of stacking behind it. This guards every part of the app that queues a scan, not just restoring — twenty quick restores used to mean twenty scans.",
      "Both duplicate folder lists were reading a folder by pulling every photo id in it into memory and then asking about them four hundred at a time across nine tables. The covering folder on the Stored elsewhere tab is routinely an entire library, and that page reloads every three seconds while a scan runs. It is three fixed queries a folder now, however much the folder holds.",
      "Those queries were also unable to use an index at all — SQLite cannot use one for the \"everything below this folder\" test the old code was written with. They ask for a range instead, over a new index, which is the difference between reading a slice of a library and reading all of it. Nothing to do on your part: it is added the next time the server starts.",
      "As a side effect of that, a folder named \"Photos\" no longer matches paths under \"photos\".",
      "Restoring a large number of items no longer blocks everything else for the duration; the server keeps serving between items."
    ]
  },
  {
    version: "2.20.1",
    label: "Where the copies actually are, instead of \"Library root\"",
    changes: [
      "A folder on the Stored elsewhere tab could say every photo in it was \"also in Library root\", which is the name of nothing: the library's top folder is the root of every path in it, not a folder anyone named. Beside a real folder name it looked like one, and sent people off to open a folder holding none of what the card was about. It shows as \".\" now.",
      "More to the point, the card names the folders the copies are ACTUALLY in. The folder that covers a set of copies and the folders those copies sit in are only the same thing when the coverer is a real folder — it is often a whole library, either because the copies are spread across several of its folders or because that library was marked \"keep here\", which outranks the usual tightest-fit rule on purpose. Both the explanation and the kept folder now name the real folders, up to three of them and a count of the rest.",
      "Which also answers, without any reasoning on your part, why a whole library was named: one folder listed means a saved instruction put the library ahead of it; several means the copies really are scattered."
    ]
  },
  {
    version: "2.20.0",
    label: "A Utilities section, and a way to undo an emptying you regret",
    changes: [
      "The control panel has a Utilities section: tools that work ON a library rather than settings that configure one. It opens to a Gallery branch, because everything under it so far works on photos.",
      "Duplicate photos, Duplicate folders, Stored elsewhere and Missing photos all live there now, as four tabs side by side. They were scattered through Maintenance among backups and scheduled jobs, which is where you look after the server rather than after the library. Every address any of them has ever had still lands on the right page.",
      "The duplicate pages have been reworked: the library picker, Scan and the bulk delete moved up into the page header where the page's own controls belong, search has a field of its own, and each set now leads with a plain-English line saying what is being cleaned out and why it was chosen.",
      "The Recycle Bin has a Restore all button beside Empty. It puts back everything the page is showing, so choosing a library first restores that library's items and leaves the rest alone.",
      "Restoring in bulk is not all-or-nothing and doesn't pretend to be: each item goes back on its own, so one that can't — its library has since been removed, or something else now occupies the place it came from — doesn't stop the others. Whatever stays behind is named afterwards, and nothing is deleted either way."
    ]
  },
  {
    version: "2.19.1",
    label: "\"Library root\" said two different things, and neither clearly",
    changes: [
      "A duplicate copy that sits in no folder at all — directly in the library's own folder — said it was in the \"Library root\". That is the name of a place, so it sent people looking for one; open a library that files everything into dated folders and its top folder holds no photos whatsoever, which makes the label look like a lie. Such a copy now reads \"Top level\", and the details panel names the library it is the top level of.",
      "The same words meant something else again in the folder list inside the filter box, where the row with no folder name is not the loose photos at the top but the WHOLE library — every folder in that list covers what is below it, and that one is above all of them. It now reads \"Everywhere in <library>\", which is what marking it Keep here or Clear out has always done.",
      "Folder cards on the Folders and Stored elsewhere tabs still say \"Library root\", because there the subject really is a folder and that folder really is the library's top one."
    ]
  },
  {
    version: "2.19.0",
    label: "Duplicates moves to Utilities, as one destination with three tabs",
    changes: [
      "The control panel has a seventh group, Utilities: tools that work on a library rather than settings that configure one. Duplicates is its first and only occupant.",
      "The three duplicate pages have left Maintenance, where they sat as three peers among backups and scheduled jobs, and become three tabs of one destination — Photos, Folders, Stored elsewhere. They were always three views of a single scan, and the nav was the last place still pretending otherwise. Every address they have ever had still lands on the right tab.",
      "That is the panel's first second row of tabs, and it is meant to stay rare: a tab gets its own row only where one destination genuinely has several views of the same thing.",
      "\"Folders already stored elsewhere\" has left the bottom of the duplicate folders page and become its own tab beside it. It was a second list under however many cards the first one had, which is a poor place for a decision of its own; each tab now links to the other with its count.",
      "Those folders are shown as the same card the duplicate-folder sets use: a strip of the pictures themselves, then the folder being kept and the folder that goes side by side — green and red — each with its path, when it was added, its size, and the tags and links it carries. \"Delete this\" and \"Keep this\" sit on the cards, as they do next door.",
      "Which folder is kept is deliberately NOT a choice on that tab, and the page says why: coverage runs one way, so swapping the two would delete the photos that exist only in the folder being kept.",
      "Where the kept folder is the one holding the other inside it, the card says so and says how many photos it is left with — its own count includes what is about to go, which otherwise looks like the number dropped for no reason.",
      "The tab has the sorting, paging, search, filters and rebuild the other folder page has.",
      "Both folder lists could go on offering a folder whose photos had already gone — deleted here, deleted from the gallery, or emptied out of the Recycle Bin. The card advertised photos and megabytes that weren't there, and every button on it failed. Every number on both pages is now read from the library as it stands rather than from what the scan recorded, and a folder left holding nothing drops off the list on sight.",
      "Deleting a folder now also clears the other results that named it — above all an offer to remove some further folder \"because its photos are safe in here\", which after the deletion would have been an offer to bin the last copies.",
      "A refused deletion says which of the three things went wrong instead of always blaming the copies. A folder that is simply empty now says so, and no longer sends you looking for photos that were never lost.",
      "An error from a confirmation dialog is shown in the dialog only, not there and on the page behind it at once."
    ]
  },
  {
    version: "2.18.0",
    label: "Duplicate folders, rebuilt as cards",
    changes: [
      "Each duplicate folder set is now a card: numbered, with what the folders hold, a strip of the pictures themselves, and the folders side by side — green for the one being kept, red for the one that goes. Each carries its path, when it was added, its size, and a single button. Click a red folder's name to keep that one instead; \"Delete this\" now removes just that folder rather than every copy in the set.",
      "The folder list gained sorting (newest, largest, most photos, name), paging, and a search box in the bar beside the filters.",
      "Two sections could show the same pair of folders — once as an equal-contents set, once as \"already stored elsewhere\". The rule against that only applied when results were rebuilt, so a set found by an older version kept showing twice. It now applies whenever the page is read, so a stale result can't be displayed at all.",
      "A new rebuild button on both duplicate pages recomputes every list from what the last scan already worked out, without reading a single file. That is the thing to press whenever a list looks wrong — a full scan re-reads the whole library and is rarely what's needed.",
      "Keep and Clear now save the moment you click them, and moved into the filter box beside the folder they apply to. A separate Save step for one control in a box where everything else applies instantly read as a control that didn't work.",
      "Duplicate photos can be narrowed to photos or videos only, and search has left the filter box on both pages.",
      "When a copy is kept in a folder you asked to clear out — which happens when every copy is in one, since clearing can never empty a folder — the set now says so instead of looking like the setting was ignored."
    ]
  },
  {
    version: "2.17.2",
    label: "The filter box is two tabs, not one long scroll",
    changes: [
      "Putting every filter in one box made it too tall: the folder list runs to as many rows as you have folders, and it pushed the library, kind and search fields out of sight. It is two tabs now — What to show, and Folders — each with a count, so a filter set on the tab you're not looking at can't be forgotten. The folder list gets the height it needs on its own tab."
    ]
  },
  {
    version: "2.17.1",
    label: "Fixed the blank Duplicate photos page",
    changes: [
      "2.17.0 could leave the Duplicate photos page blank: rearranging its filters left one value being read a few lines before it existed. It compiled and built cleanly and then failed the moment the page drew itself. Fixed, and the same check run over the folders page, which was unaffected."
    ]
  },
  {
    version: "2.17.0",
    label: "One filter box, and a bulk delete that obeys it",
    changes: [
      "The bulk delete ignored everything except the library picker. Filter to one folder, or to identical files, press it, and it still swept every identical set in the install — the page said one thing and the button did another. It now covers exactly the sets your filters leave on screen, across every page of them, and the confirmation says how many that is out of how many were found.",
      "Library, which-duplicates, search and folders were four controls in three places, with nothing to say how they combined. They are one Filters box now, on both duplicate pages, with a count on the button so a narrowed page says so even when the box is shut.",
      "Near-identical sets are still never swept in bulk, whatever the filters say, and the button names that in its own label."
    ]
  },
  {
    version: "2.16.2",
    label: "The bulk delete button says what it covers",
    changes: [
      "\"Delete all extras\" has only ever removed copies from identical sets — near-identical ones are excluded by the query itself, so nothing on the page can widen it. But a lone trash icon above a list holding both kinds reads as though it might take the lot. It now says \"Delete extras in identical sets (never near-identical)\"."
    ]
  },
  {
    version: "2.16.1",
    label: "Show only the duplicates you can clear without looking",
    changes: [
      "A new control on Duplicate photos narrows the list to one kind: identical files only, near-identical only, or everything. Identical files are byte-for-byte matches, so there is nothing to compare — choosing them puts exactly the sets you can clear in bulk on screen, and nothing else.",
      "That also lines the page up with Delete all extras, which has always refused to touch near-identical sets: with identical-only chosen, what the button does and what you can see are finally the same thing."
    ]
  },
  {
    version: "2.16.0",
    label: "Tell it which folder to clear out",
    changes: [
      "The folder preference could only say \"keep the copies here\". It now says the opposite too: mark a folder Clear out and the copies elsewhere are kept while that folder's go — the way you retire a folder whose photos are already filed properly somewhere else. Every folder is one of three things now: Keep here, no preference, or Clear out.",
      "Clearing out cannot empty a folder on its own. A photo with no copy anywhere else isn't a duplicate, so it is never touched, and a set whose every copy sits in cleared-out folders still keeps one. It changes which copy survives, never whether one does.",
      "A folder being cleared out is also the one offered for removal when everything in it turns out to exist elsewhere, and is never proposed as the place to keep photos.",
      "The most specific instruction wins, so you can keep a whole library and clear out a single folder inside it.",
      "The Recycle Bin now says how many items it holds and how much space they take, following the library picker — with one chosen it also gives the total for the whole bin, since deciding whether to empty it is usually why you are there."
    ]
  },
  {
    version: "2.15.1",
    label: "Backups were being written where an update would lose them",
    changes: [
      "In Docker the server was writing backups to a folder inside the container image rather than the one you mapped for its data. They didn't appear on the host, and every container update — including this one — threw them away. Fixed: backups now go to /config/backups, which is the backups folder inside your mapped Config & Data share.",
      "Backups already stranded in the old place cannot be saved by this update: updating replaces the container, and that is the moment they are discarded. If you have not updated yet and want to keep them, copy them out first with `docker cp isputnik:/app/data/backups/. /mnt/user/appdata/isputnik/backups/`. The server does move any it still finds on startup, which covers installs that are not containers.",
      "The Backup page has said where it writes all along; it now explains that in Docker that path is inside the container and points at the folder you mapped."
    ]
  },
  {
    version: "2.15.0",
    label: "Duplicate folders has its own tab",
    changes: [
      "Whole folders have moved out of Duplicate photos onto their own tab beside it, under Maintenance. They are a different size of decision — clearing one folder settles hundreds of the photo sets next door — and burying them above a long list of single photos made that easy to miss.",
      "Both lists live there: folders holding exactly the same photos, and folders whose every photo also sits somewhere else. Scanning stays on Duplicate photos, so there is still one place that starts the work; the new tab reports what the last scan found and updates itself while a scan is running.",
      "Each page links to the other, and Duplicate photos says how many whole folders are waiting — the thing worth doing first."
    ]
  },
  {
    version: "2.14.0",
    label: "Folders already stored elsewhere",
    changes: [
      "Duplicate photos now finds folders whose every photo also sits in another folder — including a folder copied into itself, which no exact match can ever catch, because the outer folder holds the inner one's photos as well and so always holds more. Each row says what goes, what stays, and how many photos the kept folder has besides.",
      "Two folders that cover each other — the same pictures in a different arrangement — are only ever offered one way round. Offering both would delete every copy between them.",
      "A new folder filter narrows the page to the folders you want to work on, listing only folders something duplicated was actually found in.",
      "You can now say where copies should be kept. Choose one or more folders and the copy in them is the one kept, for single photos and whole folders alike, ahead of every automatic guess — nothing is lost by it, because the other copies' tags and people are merged onto the survivor either way. A folder you've chosen is also never offered for removal.",
      "The page now says plainly that duplicate detection is experimental. It proposes deleting photographs: check what a set holds before removing anything, start with a few rather than the bulk actions, and remember everything removed waits in the Recycle Bin until you empty it."
    ]
  },
  {
    version: "2.13.1",
    label: "Duplicate folders says when it found nothing",
    changes: [
      "The new Duplicate folders section only appeared when it had something to show, so on a library with no duplicated folders it looked as though the feature wasn't there at all. It now stands after every scan and says plainly that no folder holds exactly the same photos as another — which is the answer you came for, and a different thing from the check not having run."
    ]
  },
  {
    version: "2.13.0",
    label: "Duplicate folders, not just duplicate photos",
    changes: [
      "Duplicate photos in the control panel now finds whole folders that hold the same pictures as another folder, whatever the two are called. A holiday folder copied into a backup used to arrive as four hundred separate decisions; it arrives as one.",
      "Folders are matched on what is inside them — every photo, and where it sits in the folder — never on the name. Two folders holding the same pictures arranged differently aren't a pair, and neither are two that agree on all but one photo.",
      "Pick the folder to keep by clicking it; the suggestion favours the one whose photos you've tagged or filed into albums, and passes over anything named or filed like a copy. Deleting the others moves their photos to the Recycle Bin, handing each photo's tags, albums and tagged people to its twin in the folder you kept.",
      "The folders are checked again the moment you confirm. If so much as one photo in them has changed since the scan, nothing is deleted and you're asked to scan again.",
      "This costs nothing extra to find: it reuses the fingerprints the duplicate-photo scan already takes, and reads no files of its own."
    ]
  },
  {
    version: "2.12.2",
    label: "Folders say how much is in them",
    changes: [
      "Browsing the gallery by folder now tells you how many photos and videos are in the folder you have open, at the top of the page and above the pictures themselves. Before, the only counts were on the folder tiles, so once you were inside a folder the number you had just read was gone.",
      "A folder with folders inside it counts both ways — what is loose in this folder, and everything below it — because that second number is the one its tile showed you on the way in.",
      "A folder holding more than 200 photos only ever showed the first 200, with nothing to say there were more. There is now a Load more button under the pictures, the same one the main photo list has."
    ]
  },
  {
    version: "2.12.1",
    label: "Photo thumbnails look at faces",
    changes: [
      "A square thumbnail of someone standing used to show the middle of them — a torso, no face. Thumbnails now aim at the people in the photo, so you can tell who is in a picture without opening it. Group photos aim at everyone rather than one person.",
      "Nothing is re-made and no space is used: the small copies were never cropped, the crop happens as the page draws them, and it just needed pointing in the right direction. Photos where no face has been found are unchanged, as are photos where the faces are already in the middle.",
      "This uses what the face scan has already found, so a photo the scan hasn't reached yet keeps its old thumbnail until it has.",
      "Downloading a photo now saves it under its own name. Every download used to arrive called \"file\", then \"file (1)\", \"file (2)\", because the download never told your browser what the picture was called. Saving a photo with right-click gets the proper name too.",
      "In the control panel, the way back out is now \"Home\" at the top of the menu, where Home sits everywhere else, instead of \"Back to library\" tucked at the bottom. The search box moved below the list of sections."
    ]
  },
  {
    version: "2.12.0",
    label: "Everything you've shared, on one page",
    changes: [
      "Profile has a new Shared links tab listing every guest link you've made — for a book, a photo, an album, or a batch of photos — with what each one opens, when you shared it, and when it stops working. Links that have already run out are listed underneath, greyed, because finding out that a link expired is usually why you came looking. Revoking one cuts it off straight away; people you shared with by their account are not affected.",
      "The links themselves aren't shown, and can't be. Only a fingerprint of each link is kept, never the link, so it can be shown to you exactly once — the moment you create it. If you've lost one, revoke it and make another. The gain is that a stolen copy of the database still opens nothing.",
      "Fixed the Share box listing links belonging to a different book. It matched books by title, so two things named the same shared each other's links — and the revoke button could remove the wrong one.",
      "iSputnik.home is now properly open source, under the GNU AGPL. About links to the code it is running, which that licence asks for — anyone using this server is entitled to the source behind it."
    ]
  },
  {
    version: "2.11.9",
    label: "Adding photos to a relative is tidier",
    changes: [
      "The Add photos window on a person's page printed its folder trail — and any message it had for you — on top of the folder tiles underneath. The family tree's version of that window carries one band more than the layout allowed for, and the band holding those two was squeezed to nothing. Every band now takes the room it needs, and only the photos scroll.",
      "A relative who is linked to a face in the gallery still opens on their face matches, but if the scan hasn't matched anything to them yet the window opens on the gallery folders rather than an empty list.",
      "Photos on the life timeline are a little larger, so a face is recognisable without opening the photo."
    ]
  },
  {
    version: "2.11.8",
    label: "Long slideshows render a piece at a time",
    changes: [
      "Rendering a movie no longer holds every slide open at once. Past a dozen photos the movie is made in pieces and joined at the end, so a long slideshow costs no more memory than a short one — and the finished film is identical, down to the millisecond, with the same cross-fade between every pair of photos.",
      "The video tool was also giving each photo its own set of decoding threads, which was where most of a render's memory went. One thread each now.",
      "Together with the previous update, a 63-photo render went from around 17 GB on a self-hosted server to under 600 MB. It takes about a third longer than the old all-at-once approach, and runs quietly in the background while the rest of the server carries on."
    ]
  },
  {
    version: "2.11.7",
    label: "Rendering a movie no longer needs a workstation",
    changes: [
      "Rendering a slideshow used to load every photo at its full camera resolution and keep them all open at once — even though the movie is 1080p and each one was being shrunk anyway. On a 63-photo slideshow from a modern camera that meant around 17 GB of memory and a server with nothing left for anything else.",
      "Each photo is now shrunk to the movie's own size first, one at a time, before the encoder ever opens it. The same 63 photos measured 3.9 GB and 5 minutes before this change, and 1.7 GB and one minute after — and it no longer matters how large the originals are.",
      "Rotated photos finally appear upright in the movie. The encoder only ever saw raw pixels, so a photo you'd turned in the gallery came out on its side; the shrunken copies carry both the camera's orientation and your own rotation."
    ]
  },
  {
    version: "2.11.6",
    label: "A background job can no longer take the server down with it",
    changes: [
      "Important fix for anyone who saw the server pinned at full CPU and memory after 2.11.4. If a background job was heavy enough to exhaust the machine's memory, it took the whole server with it — and on restart the server picked up exactly the same job and did it again, forever. The attempt limit never applied, because a job that kills the process never gets as far as failing. Now a job is only picked back up while it has attempts left; after that it stops and says the machine may not have had enough memory. This covers movie rendering, video conversion, and every library and face scan.",
      "Rendering a movie and converting a video now take at most half the machine's cores, and run at the lowest priority. They still use whatever is idle — they just stop competing with everything else the server is for.",
      "A slideshow whose render was abandoned this way now says so in the editor instead of sitting on “Rendering movie…” for good."
    ]
  },
  {
    version: "2.11.5",
    label: "The title card is back, on every machine",
    changes: [
      "Slideshow movies open on their title card again. The last update had to leave it out on a self-hosted server, because the video tool inside the container can't draw text — and refusing the card was the only way to stop it refusing the whole movie.",
      "The card is now drawn before the video tool is involved: the slideshow's name is turned into lettering here, as a picture, and handed over like any other photo. Nothing about it depends on which machine you run on any more, so the movie looks the same everywhere. Names in Russian render properly, as they always did.",
      "A name too long for the frame now shrinks to fit instead of running off both edges."
    ]
  },
  {
    version: "2.11.4",
    label: "Slideshow movies render again",
    changes: [
      "Exporting a slideshow as a movie failed every time on a self-hosted server, with \"Filter not found\" — and worked in development, which is why it went unnoticed. The video tool ships a different build for each operating system, and the one inside the container is missing the piece that draws the opening title card. It refuses the whole movie over it, before encoding a single frame.",
      "The renderer now asks the installed video tool what it can do and makes the movie it can make. On a build without that piece the movie renders without its opening title card rather than not at all; everything else — transitions, music, the photos themselves — is unchanged. Getting the title card back on Linux is next."
    ]
  },
  {
    version: "2.11.3",
    label: "A failed movie now says what went wrong",
    changes: [
      "When rendering a slideshow to a movie failed, the message told you to check the server logs for ffmpeg's output — and there was never any there to check. The encoder's error output is now captured: the dialog repeats the line where ffmpeg says what broke, and the full output, the exit code and the command that produced it go to the server log. Being killed for memory — the usual end of a very long slideshow in a container with a tight limit — is named as that, since it leaves no output of its own.",
      "The same silence covered video conversion, which now records why a file it couldn't convert failed.",
      "A render with a great many photos could also hang instead of finishing, because nothing was reading what the encoder wrote. It's read now, so it can't fill up and stall."
    ]
  },
  {
    version: "2.11.2",
    label: "The address Google gave you now works",
    changes: [
      "“Copy address” in Google Maps gives you something like “8MW8+4JV, Norman Manley Blvd, Negril, Jamaica” for anywhere without a street number — and pasting that into the gallery's location search found nothing at all, because the place lookup doesn't understand the code at the front. It does now: paste the address as copied and the pin lands on the code itself, not on the middle of the town. The long form that starts with the region, “77C38MW8+4JV”, works on its own and doesn't even need internet.",
      "A code pasted with nothing after it now says what it's missing — a short Plus Code only means something next to a place name, so keep whatever followed it.",
      "On Maintenance → Duplicate photos, each copy now shows its file size on the tile, under the folder. In a near-identical set that's the quickest read on which copy is the original and which is the re-saved one; it used to mean opening the details of each copy in turn."
    ]
  },
  {
    version: "2.11.1",
    label: "One library at a time on Duplicate photos",
    changes: [
      "Choosing a library on Maintenance → Duplicate photos now compares that library's photos with each other. Each set shows only the copies living there, and a photo whose only other copy sits in a different library no longer appears at all — it isn't duplicated in the library you're looking at. Before, a chosen library still listed sets whose copies were somewhere else entirely.",
      "Where a set does have copies in other libraries, the page says how many and leaves them alone. Nothing outside the library you picked is ever deleted from that view, and the confirmations say so before you press anything.",
      "“Delete all extras” follows the same rule: it thins the chosen library down to one copy per set and never reaches into another library. Pick “All libraries” to compare across them, which is where the same album imported into two places belongs."
    ]
  },
  {
    version: "2.11.0",
    label: "A control panel that answers back",
    changes: [
      "Refresh used to look broken: the answer comes back in milliseconds, the numbers are usually the same, and nothing on screen moved — so you couldn't tell whether it had done anything. It now spins for a moment and says “Updated” when it's finished. Every page in the control panel that shows live data has one, seventeen tabs in all, and each reloads everything on that page rather than part of it.",
      "Scheduled jobs is one row per job instead of a stack of cards: what it is, how often it runs, when it last ran and when it runs next, on or off, and Run now. Jobs are grouped by what they're about — audiobooks, ebooks, gallery, then the system chores — and there's no Save button any more, since changes save as you make them.",
      "Run now used to finish instantly and tell you nothing, because most of these jobs don't do the work themselves — they queue it. It now keeps running until the work is genuinely finished, with a message that says what was queued and a link straight to Tasks to watch it. Jobs that do their work on the spot just report the result.",
      "The Recycle Bin shows what you deleted. Items are tiles led by the cover they had — a photo, a book jacket — with the folder they came out of, their library, size, who deleted them and when, and the date they disappear. There's a library filter, sorting, and paging. Items binned before this update show an icon for their media type instead; their thumbnails were already gone.",
      "Logs got the same treatment as the Duplicate photos page: search beside the title that filters as you type, and one toolbar holding the filter, rows per page, refresh and cleanup. “Delete older than N days” moved into the confirmation, where you actually use it."
    ]
  },
  {
    version: "2.10.0",
    label: "Fixing the date and place a camera got wrong",
    changes: [
      "Select photos in the gallery and you can now set when and where they were taken. “Set date taken” either stamps one date and time on everything selected — right for a batch of scans from the same occasion — or shifts each photo from its own date by the same amount, which keeps the order and spacing the camera recorded. That second one is the fix for a camera left on the wrong timezone or a clock that was hours out.",
      "“Set location” drops one pin on the whole selection, and those photos join the Map view. Rather than hunting across a world map, type a place, address or postcode and pick from the results — the map jumps there with the pin already placed. Coordinates work too. The same search now sits in the single-photo editor in the viewer.",
      "Whatever you set this way is kept as yours, so the next library scan won't overwrite it.",
      "The selection toolbar is now a row of icons rather than text buttons, so it stays on one line at any window size — in the gallery, audiobooks and ebooks alike. Hover an icon to see what it does.",
      "On Maintenance → Duplicate photos, choosing a library now filters the sets on screen to the ones that library takes part in. It used to only limit which files the next scan read, which made the picker look broken. “Delete all extras” follows the same choice instead of always reaching every library."
    ]
  },
  {
    version: "2.9.0",
    label: "Every settings page has an address",
    changes: [
      "Your Profile's four tabs — Account, Security, Appearance and Devices — each have their own address now. Bookmark the one you keep coming back to, send someone a link straight to it, and use the back button to return to the tab you were on instead of being thrown off the page.",
      "The old Theme link now opens Profile's Appearance tab directly rather than dropping you on the page's first tab."
    ]
  },
  {
    version: "2.8.3",
    label: "One more line that wouldn't fit",
    changes: [
      "The database's “Last modified” card ran its timestamp onto two lines at every window size, full-screen included. The date now sits on the card's main line with the time underneath, the way the other cards carry a value and a note."
    ]
  },
  {
    version: "2.8.2",
    label: "Readable numbers on smaller screens",
    changes: [
      "The metric cards on System and Statistics squeezed four or three across no matter how narrow the window, so on a smaller laptop a label broke as “Total librarie/s” and a size read “6.8/8 GB”. They now step down to two across, and to one on a phone, while a full-size window looks exactly as it did."
    ]
  },
  {
    version: "2.8.1",
    label: "Follow-ups to the new control panel",
    changes: [
      "Messages around the app still sent you to the old menu — “Configuration → Email” for the sign-in alert warning, “Libraries → Tasks” for scan progress, and a few others. They now name the places things actually live.",
      "On a narrow window the media-type picker on the Statistics page was squeezed until its label was cut off. Header buttons now drop to their own line instead of being crushed.",
      "Fixed a long-standing glitch on the Tasks page that could make rows behave oddly when opening an error for a finished task."
    ]
  },
  {
    version: "2.8.0",
    label: "A control panel you can search",
    changes: [
      "The control panel has been reorganised into six sections — Overview, Library, Members, Security, Maintenance and Settings — each with its own row of tabs. Things now sit where you'd look for them: Backup is under Maintenance rather than hidden inside Config, and the photo cleanup tools moved out from behind the Libraries page.",
      "Press Ctrl+K (⌘K on a Mac) anywhere in the control panel, or use Search at the top of the menu, and type what you're after. It searches the settings themselves, not just page names: “smtp” goes to Email, “lockout” to the security policies, “thumbnail” to Storage. It's usually faster than remembering which tab something lives on.",
      "Every page in the control panel now has its own address, including ones that never did — the email server settings, reader access tokens, the lockout thresholds, trusted networks and blocked addresses. You can bookmark any of them, and links in the guides now go straight to the right page.",
      "The three separate statistics tabs — audiobooks, ebooks, gallery — are one page with a media-type picker, and every page now says which section it belongs to in the same words as the menu.",
      "All your old links still work. Anything you bookmarked before will land on the page it moved to."
    ]
  },
  {
    version: "2.7.0",
    label: "You decide which copies stay",
    changes: [
      "Duplicate photos used to keep exactly one copy from a set and remove the rest. Now every copy is yours to mark: click one to switch it between Keep and Delete. Keep two of three, keep all of them, or clear a whole set out — the set tells you what you've chosen before anything happens, and nothing is acted on until you press Delete.",
      "Removing every copy is possible now, and asks in its own words rather than the usual reassurance that the kept photo is safe: there is no kept photo. The picture leaves the gallery entirely, and its tags, albums and tagged people go with it, because there's no copy left to move them onto. Everything still goes to the Recycle Bin, so it's undoable until you empty it.",
      "A new view button opens a set full size — one copy at a time with the arrow keys, or two side by side. Comparing two is the point for near-identical sets, where the difference is in the picture and a thumbnail won't show it. Clicking a photo there marks it, exactly as clicking a tile does.",
      "Long lists are easier to work through: search by filename, folder or library, sort by size to reclaim or number of copies or identical-first, and page through sets instead of scrolling one endless column. Sets whose copies share both a name and a size collapse to a single thumbnail — seeing the same picture three times tells you nothing.",
      "Each copy now says which library and which folder it lives in, so two copies sharing a filename can finally be told apart at a glance, and its details open a link straight to that folder in the gallery."
    ]
  },
  {
    version: "2.6.0",
    label: "The same photo, saved twice",
    changes: [
      "Duplicate photos now also finds the same picture saved as a different file — a copy that came back smaller from a messaging app, an export at another quality, a resized version you made and forgot about. Until now it only caught files that were byte-for-byte identical.",
      "These land in their own “Near-identical” list, kept separate from the identical ones on purpose. They're matched on what the picture looks like, deliberately narrowly, so two similar shots of the same moment are left alone — but they're still worth a look before you remove anything, and “Delete all extras” never touches them.",
      "One difference worth knowing: when you remove an identical copy, people tagged on it move to the copy you keep. For a near-identical one they don't — a face marked on a smaller version sits in the wrong place on the original, so it's left alone rather than moved somewhere wrong. The app says so before you delete."
    ]
  },
  {
    version: "2.5.0",
    label: "Find the same photo twice",
    changes: [
      "A folder imported twice, or a phone backup copied in beside the originals, quietly leaves the same picture in your library several times. Control panel → Libraries → Duplicate photos now finds those and lets you keep one.",
      "Only files that are byte-for-byte identical are grouped, so a set is never a guess — two similar shots of the same moment are left alone. It's quick because identical files must be the same size: any photo whose size matches nothing else is skipped without ever being opened.",
      "The copy it suggests keeping is the one carrying work you can't get back — tags, albums, tagged people — and it says why. Pick a different one if you disagree; your choice sticks. Whatever you delete goes to the Recycle Bin, and its tags, albums and people move onto the copy you keep first, so nothing you filed by hand is lost.",
      "Scan everything or just one library, and see beforehand how many files each would need to read. A new weekly job looks for duplicates on its own — it only ever reports, and nothing is deleted unless you ask.",
      "Elsewhere: the family tree has its own mark now — a small branch-and-figure drawing — standing in for relatives who have neither a photo nor a name yet, and a tree with nobody in it looks deliberately empty rather than broken."
    ]
  },
  {
    version: "2.4.2",
    label: "Tidier guides",
    changes: [
      "Tidied up how the guides look now that they're read inside the app: words in table headings no longer break across two lines, narrow columns keep their width, and a section break no longer draws two lines where it meant to draw one.",
      "Versions 2.4.0 and 2.4.1 were tagged but never published — the packaging step left the guides out and the build stopped. This release is those changes plus the fix, so upgrade straight to it."
    ]
  },
  {
    version: "2.4.0",
    label: "The guides now live inside the app",
    changes: [
      "Help & guides used to send you to GitHub to read anything. The guides are now part of your server: they open inside the app, they work with no internet connection at all, and they describe the version you're actually running.",
      "That matters most when you need them least conveniently — a server on a home network with no way out, or a connection that's down, still has its full documentation.",
      "Pictures in the guides are the one thing still fetched over the network, to keep the offline copy small. A guide read offline shows its text and skips the screenshots.",
      "Every guide keeps a “View this guide on GitHub” link at the bottom, for when you want the newest version rather than the one that shipped with your install."
    ]
  },
  {
    version: "2.3.2",
    label: "Three new guides, and help that matches your version",
    changes: [
      "There are now written guides for the parts of the app that had none: your account (your name and sign-in email, themes, the e-reader address, and where favorites, bookmarks, quotes and collections live), setting up email, and a tour of the control panel. All three open from Help & guides.",
      "The email guide covers the two things people get stuck on: most mail providers need an app password rather than your normal one, and the encryption setting has to match the port — mismatch them and the test sits there until it gives up rather than saying what's wrong.",
      "The control panel guide spells out two things the screens don't. Deleting a user only deactivates the account and signs them out — their libraries, groups and files stay. And restoring a backup doesn't take effect until the server restarts.",
      "Help links now open the guides for the version you're actually running, instead of always the newest ones. Reading about a button that isn't in your copy of the app was needlessly confusing. This starts working from this release onward."
    ]
  },
  {
    version: "2.3.1",
    label: "Old photos land on the right date again",
    changes: [
      "Photos that carry no date of their own — anything sent through a messaging app, exported from a phone, or downloaded from a photo service — were being filed under the day they arrived on your server rather than the day they were taken. A holiday from 2012 could sit in the middle of this year's timeline.",
      "Where the date is in the file's name, as it usually is for those photos, it is now used. Names like 2012-12-02T16-38-20.jpg, IMG_20121202_163820.jpg and IMG-20121202-WA0001.jpg are all understood. A date recorded by the camera still wins, and a date you set by hand is never touched.",
      "The reading is deliberately cautious: a name has to hold a real, plausible date to be believed, so a photo named after a serial number won't be filed under a made-up day. Anything unclear falls back to the old behaviour.",
      "Photos already in your library are corrected as their library is scanned — no need to re-import anything. Only the ones that were filed by arrival date change; everything else stays where it is."
    ]
  },
  {
    version: "2.3.0",
    label: "A family tree you can steer, and photos that land on the right person",
    changes: [
      "The family tree's buttons have moved off the page and onto the chart itself, as a strip down the left: Add person, Home, All People, Families, Import, Export and Settings. Home returns to the person the tree opens on and refits the view. The header above keeps just the name, the count, and the search box.",
      "Each card in the chart now carries a single ⋯ button instead of a stack of small icons. It opens a short menu: open the profile, edit the person, add a relative — whichever of those you're allowed to do.",
      "A legend on the right explains what the chart is showing: who is who by colour, which person is in focus, and the two kinds of line between cards.",
      "The chart now tells a current partner from a former one. A marriage still in place shows two linked wedding rings; a divorce shows them pulled apart and cut through, and the line between the couple turns dashed. Someone who has remarried no longer looks married to two people at once. The lines down to children never change — they are no less the couple's children for it.",
      "There is a new Families page listing your family names, one card each, with the people in them. Choosing one opens the chart on that family's earliest member — a way into a large tree without hunting for a name.",
      "When a person in the tree is linked to a face in the gallery, adding photos to them now starts from that list of matches instead of making you go through folders. The same list is offered when you set their portrait and when you add photos to a life event.",
      "The portrait button on a profile now offers the same three choices as everywhere else — face matches, any photo in the gallery, or a file from your device — rather than going straight to a file dialog.",
      "Uploading from the family tree is now only offered once an administrator has chosen which gallery library those photos go to, instead of offering it and then explaining it can't. Portraits go to that library too, so every picture you add lives in the gallery like any other photo.",
      "In the gallery, a group of faces that wrongly swept in a stranger can now be corrected properly. Open the person, choose Pick photos, select the ones that aren't them, and move them to the right person — or to a new one you name there and then. The rest of the group stays put, other people in those photos are untouched, and the correction survives the next face scan."
    ]
  },
  {
    version: "2.2.1",
    label: "A security fix for the Back button",
    changes: [
      "Fixed a flaw in the Back button on person, series, category and tag pages. A link to your library crafted by someone else could make that button lead to another website instead of back where you came from — a page that looked like yours sending you somewhere that isn't.",
      "Nothing on your server was reachable through it and no account or file was exposed, but updating is recommended, especially if your library is reachable from the internet."
    ]
  },
  {
    version: "2.2.0",
    label: "Two-factor codes by email, and a starting person for the tree",
    changes: [
      "The family tree can now be told who to open on. An administrator picks the person once in the tree's settings, under Starting person, and the chart centres on them for everyone — instead of on whoever happened to come first. Opening a link to a particular person still takes you straight to them.",
      "Building the tree no longer means going back and forth to profiles. Each card in the chart now carries a + button, beside the ones for opening and editing the person, which adds a parent or a child to them on the spot. It appears on the people you're allowed to edit.",
      "Two-factor authentication no longer means installing an authenticator app. When you turn it on, you choose how you want your codes: from an app on your phone, or sent to the email address you sign in with.",
      "Signing in with the email method sends a 6-digit code to your inbox and waits for you to type it. If it doesn't arrive, there's a Send another code button on the same screen.",
      "The app is still the safer choice, and the setup screen says so plainly: an emailed code travels by email, so anyone who can read that inbox can reach your library. Pick whichever you'll actually keep using.",
      "The email option only appears if your server can send email, which an administrator sets up under Email in the control panel. Your backup codes work with either method — and they matter more with email, since they're what gets you in if the server can't send mail."
    ]
  },
  {
    version: "2.1.1",
    label: "Guides for every part of the app",
    changes: [
      "There are now written guides for setting up and using iSputnik — first run, storage, adding libraries, and one for each of audiobooks, ebooks, the gallery and the family tree. They are illustrated, and open from Help & guides.",
      "The Help page lists them all, grouped by what you're trying to do. Setup guides are shown only to administrators, since they describe the control panel."
    ]
  },
  {
    version: "2.1.0",
    label: "Adding photos to the family tree, and a gentler first run",
    changes: [
      "Photos and videos can now be uploaded straight from the family tree. Wherever you add photos to a person or an event, there is a second tab beside Browse for uploading new files — they are added to the gallery and attached in one step, filed by the date they were taken.",
      "A Settings button gathers the family tree's administration in one place: which gallery library uploads go to, GEDCOM import and export, and Branch access — who may edit which family branch. Branch access moved here from the People page.",
      "Starting out is clearer. Audiobooks, Ebooks and Gallery now explain what a library is for when there isn't one yet and offer a button straight to where libraries are created; the Libraries page does the same for storage, which has to be set up first.",
      "Links that look like buttons now behave like buttons — no stray underline, and their icons match the button's text instead of turning a different colour."
    ]
  },
  {
    version: "2.0.0",
    label: "Tags across everything, and a fresh foundation",
    changes: [
      "The Tags page now covers the whole library, not just books. A row of filters — All, Audiobooks, Ebooks, Gallery, Family tree — narrows the list to where a tag is actually used, and each tag shows its count for the type you picked.",
      "Opening a tag shows everything carrying it: books, photos and videos, and family members, each in its own section. Photos open right there rather than sending you off to the gallery, and a family member opens their profile.",
      "The tag list stays readable at any size: the most-used tags are shown first with \"Show all\" for the rest, and a sort control switches between most-used and A–Z.",
      "Under the hood, the database schema was consolidated into a single definition, so a new installation is set up in one step. Existing installations running 1.16.0 carry over untouched; an installation older than that should be updated to 1.16.0 first, which prepares it for this version."
    ]
  },
  {
    version: "1.16.0",
    label: "Family branches, and a richer timeline",
    changes: [
      "Family members can be tagged by branch — usually a last name — and the People page gained a row of tag chips to filter by. Tags live under their own tab in the Add/Edit person form, alongside Bio / notes.",
      "Those tags now grant editing rights. \"Branch access\" on the People page lets an administrator make someone the editor of one branch: they can edit everyone carrying that tag and add relatives to them (new people join the branch automatically), while deleting people, unpicking relationships, importing a GEDCOM file, and the tags themselves stay with administrators.",
      "The timeline understands more of a life: alongside school, work, homes and service, there are now graduations, retirements, travel, awards, baptisms and naturalizations, each with its own icon. The list of kinds reads alphabetically.",
      "Timeline events can carry their own photos — the trip, the ceremony, the medal — picked from the gallery when you add or edit the event. A row shows the first few and a \"+3\" opens the rest, and a long note is trimmed to a few lines with a More link.",
      "Photos on a profile no longer take you away: clicking one opens it right there, so closing it puts you back on the family page instead of in the gallery. The Photos tab shows a preview of twelve with \"View all photos\" for the complete set.",
      "The Add/Edit person form was tidied: Born sits beside Birthplace and Died beside its place, and the form keeps one size as you move between its tabs."
    ]
  },
  {
    version: "1.15.0",
    label: "The family tree, the way family trees are drawn",
    changes: [
      "The tree now flows top to bottom: the person you're looking at sits in the middle, parents and grandparents rise above, children hang below, and everyone of the same generation shares a row. Aunts, uncles, and cousins now appear too, laid out beside the direct line on their own generation's row.",
      "Person cards were redrawn compact, the way genealogy sites draw them: a square photo up top, first and last name on their own lines, then the years. People without a photo get a proper silhouette — blue for men, rose with a bun for women — and the centred person's card is inverted so it stands out at a glance.",
      "Adding relatives is one button now. \"Add relative\" on the Relationships tab offers Parent, Partner, Child, and Sibling in one menu — including flows that didn't exist before: adding a parent (even the second parent to an existing family) and adding a sibling.",
      "Relationships can carry their history: a pencil on each partner card opens marriage and divorce/separation dates, the place, and a status — including partners who are together but not married. Who counts as the current partner follows from those dates, former partners show their span, and the profile header says it plainly: married to, together with, divorced from, or widowed from.",
      "Two fixes on the profile: the timeline now lists the birth of each child in its right place chronologically, and editing a person no longer shows blank Born/Died fields when only a year is recorded — dates can be entered as a year, a month, or a full day, and a year-only date is never silently erased on save."
    ]
  },
  {
    version: "1.14.2",
    label: "A richer person profile",
    changes: [
      "A person's profile is now organised into tabs — Relationships, Timeline, Photos, Sources, and Notes — instead of one long page, with a summary of who they are (age, gender, current partner) up top.",
      "Relationships grew wider: alongside parents, partners, and children, the profile now also shows siblings and grandparents, each as a card you can jump to.",
      "The timeline reads better: dates are written out (\"Jun 3, 1947\" rather than raw numbers), each event carries an icon for its kind — school, work, home, service, travel — and ages are computed where the dates allow.",
      "Small touches on the tree itself: bigger cards with more breathing room, a silhouette instead of a bare initial when there's no photo, a Focus badge on the centred person, gender-tinted portraits, and the current zoom level shown between the zoom buttons."
    ]
  },
  {
    version: "1.14.1",
    label: "A redesigned family tree view",
    changes: [
      "The family tree now reads left to right: earlier generations on the left, children on the right, with each generation in its own column and couples stacked together with a small rings marker between them — the way printed family charts are usually drawn.",
      "Person cards were redesigned around the photo: the portrait sits on top, larger than before, with the name and years beneath it.",
      "Each card now carries its own buttons — one opens the person's profile, and for admins a pencil opens the edit form right from the tree. The \"Open profile\" bar that used to sit under the chart is gone."
    ]
  },
  {
    version: "1.14.0",
    label: "Family tree: GEDCOM files, life stories, and sources",
    changes: [
      "The family tree can now import and export GEDCOM files — the format Ancestry, MyHeritage, FamilySearch, and Gramps all speak. Bring a tree you built elsewhere in with one click (adding to what's here, or replacing it), and download yours as a .ged file any time as a backup or to continue it in another program. Anything the importer can't make sense of is skipped with a plain-language note rather than failing the whole file.",
      "Every person now has a life timeline. Beyond birth and death, you can record where someone went to school, where they worked, where they lived and when, military service, immigration, and anything else — each with a year or a full date, a range like 1971–1975, and a place. The profile shows it all in order, with marriages and divorces woven in.",
      "Places got more room: alongside a birthplace, a person can have a place of death, and a marriage can have a place of its own.",
      "Facts can carry their receipts. Sources — record indexes, church books, websites — live in one shared list, and any fact, event, or marriage can cite one, with a page reference and a link to the record itself. Importing a GEDCOM brings its sources and citations along, links included, and exporting writes them back out."
    ]
  },
  {
    version: "1.13.5",
    label: "A tidier Gallery on your phone",
    changes: [
      "The Gallery header now fits a phone screen. On mobile the row of view tabs — Timeline, Memories, Albums, Slideshows, Folders, People, Map — folds into a single Browse menu next to the library picker, the same compact header Audiobooks and Ebooks already use. On a desktop browser nothing changes.",
      "Memory cards open the photos straight away. Tapping a card in the \"On this day\" strip now opens the viewer on that year's photos immediately — the same as on the home page — instead of taking you to the Memories page first."
    ]
  },
  {
    version: "1.13.4",
    label: "A way to report a security problem",
    changes: [
      "The server now answers at the standard address security researchers look for. Anyone who finds a security problem in isputnik.home can now find where to report it, at /.well-known/security.txt, and it points them at the project rather than at you — a flaw in the software is the same flaw in every copy of it, and it needs fixing where the code lives. Nothing about your household or your address is published there."
    ]
  },
  {
    version: "1.13.3",
    label: "Staying on HTTPS, and a sign-in fix for home installs",
    changes: [
      "Arriving over plain http now takes you to https. If your server has an https address, typing it without the https — or following an old link — no longer leaves you on an unencrypted page typing your password into it. Where your reverse proxy or Cloudflare already does this, nothing changes: the app only steps in when nothing in front of it did, and it stays out of the way entirely on a home network served over plain http.",
      "A sign-in fix for home installs. The Unraid template offered a \"cookie secure\" setting of \"auto\", which the app did not actually recognise and treated as \"always on\" — and a cookie marked secure is never sent over a plain http home network, so sign-in was refused with nothing on screen to explain why. \"auto\" now means what it always claimed: it follows your app address, on for an https address and off for a plain http one. If this caught you, updating is the whole fix — there is nothing to change yourself."
    ]
  },
  {
    version: "1.13.2",
    label: "Two small fixes for servers opened to the internet",
    changes: [
      "Browsers are now told to stay on HTTPS. When your server is set up with an https address, it now sends the instruction that tells every browser to keep using HTTPS for the next year and never quietly fall back to plain, unencrypted http — even if someone types the address without it or follows an old link. Servers running on the home network over plain http are untouched: nothing is sent unless your address already says https, so a home setup can't lock itself out of its own site.",
      "A \"Back\" link can no longer be pointed at another site. Those links read where to return to from the web address, and a crafted address could slip a foreign site in there — so a link that looked like part of your own library could carry someone off to a stranger's page. Only paths inside your library are accepted now."
    ]
  },
  {
    version: "1.13.0",
    label: "Security alerts: know when someone gets near your account",
    changes: [
      "Optional alerts when an account signs in from a new place. Switch it on under Control panel → Security → Policies and both the account's owner and the administrators are emailed whenever someone signs in from a network the account has never been used from. Home and mobile connections that change address by themselves aren't treated as a new place, and sign-ins from your trusted networks never raise an alert. Turning it on won't flood you: the devices already in use are remembered first. It needs your email (SMTP) settings filled in, and the screen says so if they aren't.",
      "Emails when the things that protect an account change. The owner is now told when their sign-in email is changed — the old address is written to as well, since it's the one that can still object — when their password is changed either by them or by an administrator, when two-factor authentication is switched on, and when two-factor backup codes are replaced. These are exactly the changes someone would make to lock you out of your own account.",
      "A warning when someone has your password but not your phone. Three rejected two-factor codes within fifteen minutes now emails the account owner and the administrators. Reaching the code step at all means the password was accepted, so it's the clearest sign that a password is known to someone else.",
      "The server now pushes back on internet scanners. Hosts exposed to the internet are swept around the clock for other people's software — WordPress logins, leftover .env and .git files. Those requests are now refused outright and count toward the same automatic block as failed sign-ins, so a scan shuts itself out instead of running free. A share link that matches nothing at all counts too; your own expired or revoked links never do, so an old bookmark can't block your household.",
      "Nothing here is offered to search engines. Every page and file now tells crawlers not to index it, and there's a site-wide robots file saying the same. This matters most for guest share links, which are unlisted by design and could otherwise linger in a search index long after you revoked them.",
      "Wrong two-factor codes now count toward the lockout. Until now only wrong passwords could lock an account or block an address, so someone holding a working password could keep guessing codes indefinitely. Rejected codes now count on the same thresholds as any other failed sign-in. If you mistype a few codes you can lock yourself out for a while — an administrator can clear it from Control panel → Users."
    ]
  },
  {
    version: "1.12.0",
    label: "Family tree: map your family and tie it to your photos",
    changes: [
      "A new Family Tree section. Add family members with their dates, birthplace, portrait and a short life story, then link them together as partners and children — including remarriages and single parents. It lives beside the Gallery in the main menu, and everyone signed in can browse it while administrators do the editing.",
      "An interactive tree chart. The chart centres on one person, showing their ancestors above, descendants below and partners alongside. Click anyone to re-centre on them, drag to pan, scroll or pinch to zoom, and use Back to retrace where you came from. There is also an \"All people\" list for searching and managing everyone at once.",
      "Family members connect to your photos. Attach any photos or videos from your galleries to a person, or link them to a face the gallery already recognises so their pictures appear on their profile automatically — always respecting which libraries you're allowed to see. A person's portrait can be uploaded or picked straight from a gallery photo.",
      "Authors and Categories moved into the book sections. They now live in the Audiobooks and Ebooks views (in the tab row, or the Browse menu on a phone) instead of the main menu, since they only describe books. Tags now sits at the end of the main menu."
    ]
  },
  {
    version: "1.11.3",
    label: "Clearer activity logs: filters, named shares, and download auditing",
    changes: [
      "Filter the activity log. The Logs screen (Control panel → Logs) has a new Filter button that narrows the log by event type, user, or IP address — pick several at once, and the choices show as removable chips. The free-text search is still there for finding a specific title or detail.",
      "Shared links now say what was opened. Log entries for shared audiobooks, ebooks, photos, albums and photo sets now include the name of the item or album that a guest opened or downloaded, instead of just the media type.",
      "In-app downloads are now recorded. Previously only guest-link downloads were logged; downloading an audiobook, ebook, photo, video, slideshow movie, or a database backup while signed in is now written to the activity log too (with the user and IP). Viewing or streaming in the app is not logged — only actual downloads."
    ]
  },
  {
    version: "1.11.2",
    label: "Play old-format videos, and keep a movie visible after edits",
    changes: [
      "Legacy videos play in the browser. Videos whose codec no browser can decode (old MPEG-4/AMR camcorder and phone clips) used to only offer a download. A new weekly \"Convert unplayable videos\" job (Control panel → Scheduled jobs) makes a browser-playable H.264 copy of them so they play inline — the original file is never changed, and it works even on read-only media mounts. It's CPU-light per clip but runs a batch at a time, so a large backlog converts over a few weeks; you can also press Run now. Conversions show on the Tasks page as \"Video conversion\".",
      "A rendered movie no longer disappears when you edit the slideshow. Changing the music, transition, timing, order, or name used to make the finished movie vanish from the editor. It now stays visible and playable, marked \"out of date\" with a prompt to re-render when you want the changes baked in."
    ]
  },
  {
    version: "1.11.1",
    label: "Rendered movies now honour \"seconds per photo\"",
    changes: [
      "Fixed movie timing. Photos in a rendered movie were changing far sooner than the slideshow's \"seconds per photo\" setting — with 4 seconds per photo and a 2-second transition they advanced every 2 seconds and were never fully still, because each transition ate into the slides on both sides. Every photo now holds the screen for its full setting, with the transition layered on top exactly as it looks in the live player. Re-render a movie to pick up the corrected pacing (expect it to be noticeably longer, and to match what you see when you press Play)."
    ]
  },
  {
    version: "1.11.0",
    label: "Slideshow studio: movie title cards, cinematic transitions, and smarter suggestions",
    changes: [
      "Rendered movies open with a title card. Every exported MP4 now starts on a ~3-second black card with the slideshow's name and photo count, cross-fading into the first photo with the slideshow's own transition — so a saved movie carries its identity.",
      "Movies can be saved into your gallery. A new admin setting under Slideshows (\"Save rendered movies to\") picks a gallery library; every finished render is filed there as a real video — browsable in the Timeline, favoritable, shareable. Re-rendering updates the same video instead of piling up copies, and renaming the slideshow renames the saved movie on the next render.",
      "Transitions got cinematic. They're slower and now blend photo-into-photo instead of blinking through black; a new \"Transition length\" slider (0.5–5s) controls the pace in both the live player and the movie; \"Random\" varies the style at every cut; and a new \"Dip to black\" option gives the classic film cut — the old photo sinks into black and the next rises out of it. Ken Burns no longer snaps back to normal size before changing slides.",
      "Suggested slideshows open as a preview first. Tapping a suggestion now shows its photos with a \"Create slideshow\" button, instead of creating one immediately — closing the preview changes nothing. Suggestions also skip near-duplicate shots: burst photos and re-takes of the same scene are recognized by a visual fingerprint (computed during normal scans) and collapse to their best single photo, so a montage is 40 different pictures, not 12 versions of the same one.",
      "Add photos to a slideshow by browsing folders. A new \"Add photos\" button in the slideshow editor opens your galleries folder-by-folder — select across folders and add straight into the slideshow, with already-added photos marked; no round-trip through the Timeline.",
      "Movie housekeeping. A Delete button removes a rendered movie (and any temporary files) so you can reclaim space — a copy already saved to your gallery is kept. Cancelling a render from the Tasks page now actually stops it (previously the editor showed \"Rendering movie…\" forever), and the Tasks page shows renders as \"Slideshow movie\" with live progress and a result.",
      "Slideshow music is your uploads only. The synthesized built-in ambient beds were retired — upload your own tracks in the music picker; existing uploads and selections are untouched."
    ]
  },
  {
    version: "1.10.0",
    label: "Share a whole album — live links that stay in step with the album",
    changes: [
      "Share an album, not a snapshot. Open an album, then its ⋯ menu → Share album. A guest link lets anyone view and download the album's photos with no account; sharing with a specific person gives them the album under \"Shared with me.\" Both are live: as you add or remove photos, the share updates automatically — there's no fixed selection and no item cap. A share only ever exposes photos you're allowed to share, so a link can't leak a photo you couldn't hand out yourself.",
      "\"Shared with me\" now holds albums. An album shared with you appears as its own tile that opens a photo grid and viewer, always showing the album's current contents — including photos in libraries you can't otherwise browse.",
      "\"On this day\" on the home dashboard now opens the photos in a full-screen viewer you can page through — across every year — instead of jumping to the Memories page.",
      "Slideshow suggestions moved to where slideshows live. The event/trip suggestions that turn into slideshows now appear under the Slideshows tab as \"Suggested slideshows,\" so the Memories tab stays focused on your \"On this day\" anniversaries."
    ]
  },
  {
    version: "1.9.2",
    label: "Fix photo/video uploads on Unraid (read-only media path)",
    changes: [
      "Fixed uploads failing on Unraid. Adding a photo or video writes files into your library folder, but the install template mapped the media path read-only, so uploads failed (scanning, which only reads, still worked). The template now maps Media Storage as Read/Write. If you installed an earlier version, edit the container in Unraid and change the Media Storage path's access mode from Read Only to Read/Write — no reinstall needed.",
      "When a library folder can't be written to, uploads now show a clear message explaining that the media path needs to be Read/Write, instead of a raw filesystem error."
    ]
  },
  {
    version: "1.9.1",
    label: "Uploaded photos and videos are filed into dated folders",
    changes: [
      "Photos and videos you upload to the gallery now go into dated subfolders (a Year / Year-Month-Day folder) inside the library, based on each file's capture date — so uploads blend into your folder structure instead of piling up at the top of the library folder. A file with no embedded date is filed under the day you uploaded it. Files already in your library aren't moved."
    ]
  },
  {
    version: "1.9.0",
    label: "Gallery slideshows: build, set to music, and export as a movie",
    changes: [
      "Create custom slideshows in the gallery. A new Slideshows tab lets you make a named set, add photos to it (from the Timeline's multi-select or the photo viewer), drag to reorder, and choose a transition (crossfade, fade, slide, Ken Burns, or none) and how long each photo shows. Press Play to watch it full-screen with your settings.",
      "Set a slideshow to music. Pick from six built-in royalty-free beds — three gentle ambient pads and three melodic ones (Sunlit Days, Homeward, Quiet Snowfall) — or upload your own track. Preview any track in place; the music plays along with the live slideshow.",
      "Memories suggests slideshows for you. The Memories tab now gathers your photos into events and trips — clustered by when and where they were taken and who's in them (\"August 24–25, 2007 · with Lucas\") — and one tap turns a suggestion into a ready-to-edit slideshow. A \"Surprise me\" button picks one at random. The \"On this day\" anniversaries you already had are still there.",
      "Export a slideshow as a movie. Render it to a downloadable MP4 — your photos and video clips, transitions, and music, encoded in the background with live progress. Watch it right in the editor or download it to share. Videos are included (capped so one long clip can't dominate); a Ken Burns slideshow exports with a crossfade.",
      "Anyone can view a slideshow; only its creator and admins can change it. Editing a slideshow marks its movie for a fresh render so a download is never out of date."
    ]
  },
  {
    version: "1.8.23",
    label: "Gallery slideshow and clearer sub-view navigation",
    changes: [
      "Play any gallery view as a slideshow: a new play button opens the viewer full-screen and advances through your photos automatically, looping back to the start after the last one. Pick the pace (3, 5, or 10 seconds per photo), and videos play in full before it moves on. Press Space to pause or resume.",
      "Every gallery sub-view now has a clear Back button. From inside an album, a person's photos, or a folder it steps back to that list; from Memories, Albums, Folders, People, or Map it returns to the main gallery.",
      "Removed the “Documents” and “Files” placeholders that were marked “coming soon” in the navigation and the Add library screen."
    ]
  },
  {
    version: "1.8.22",
    label: "Metadata cover thumbnails — fixed for real, no more server hang",
    changes: [
      "Provider cover art (iTunes, Audible, Open Library, FantLab, LibriVox) shows as a preview thumbnail again in the metadata search — the browser now loads these covers directly, so they appear reliably.",
      "Fixed a server hang that could take the whole app offline during a metadata search: a cover download could try an IPv6 address on an IPv4-only host (e.g. Unraid) and crash the process. Remote image and metadata fetches now prefer IPv4 and fail gracefully instead of taking the server down."
    ]
  },
  {
    version: "1.8.20",
    label: "Shared audiobook player: tighter layout and one-line controls",
    changes: [
      "The shared audiobook player is more compact — a smaller cover and tighter spacing bring the whole player closer to one screen.",
      "Volume, speed, and the sleep timer now stay on a single row at every width, including on mobile (the volume control is a little smaller and shrinks to fit).",
      "The chapter list now opens upward as a scrolling popover above the Chapters button, instead of pushing the rest of the player down."
    ]
  },
  {
    version: "1.8.19",
    label: "Polish for the shared-audiobook player",
    changes: [
      "The shared player's speed control now shows the multiplier with a small dropdown arrow, instead of a speedometer icon that looked clipped along its bottom edge."
    ]
  },
  {
    version: "1.8.18",
    label: "A fuller shared-audiobook player and domain-aware share links",
    changes: [
      "Shared audiobook links now open a proper player: volume, playback speed (0.75×–2×), and a sleep timer (15/30/45/60 minutes, or end of chapter) — the same controls the in-app player has. Chapters and Download are unchanged.",
      "Fixed the shared player's progress bar being nearly invisible on light themes — the unplayed part of the seek bar was white on a white card. It now shows a clear track in every theme.",
      "Share links now use the address you're actually visiting. If more than one domain points at your library, a link you create while on one domain points back to that same domain instead of a single fixed address. (Invite links already worked this way.)"
    ]
  },
  {
    version: "1.8.17",
    label: "Redesigned category browsing and smarter genre shelving",
    changes: [
      "Categories now browse as clean, colour-coded tiles — a genre icon on its own accent colour — instead of stretched stock-image covers, and they look right in every theme.",
      "Smarter automatic shelving: more common genres are recognised, so books land in the right category more often. Historical novels now file under Classics & Literary instead of (non-fiction) History, and two new shelves — True Crime and Religion & Spirituality — split out of the crowded Science & Culture. The generic Fiction catch-all is now labelled General Fiction.",
      "Category editor: rename a mapped keyword in place (no more delete-and-re-add), and the scanned-tags list gained a search box and paging.",
      "The Labels → Tags page now pages long tag lists, and its back button is a lighter, left-aligned link."
    ]
  },
  {
    version: "1.8.16",
    label: "Flat-folder audiobooks, per-folder gallery rescan & missing-photo cleanup",
    changes: [
      "Audiobooks: a new \"Each file is a book\" scan option for a library. Turn it on and every audio file sitting directly in the library folder becomes its own book — ideal for a flat folder of single-file audiobooks (a pile of fairy tales, radio plays, and the like). Files tucked inside subfolders still group into one book per folder as before.",
      "Gallery: rescan just one folder. In the Folder view, admins now get a \"Rescan this folder\" button that reprocesses only that subtree instead of the whole library — much quicker when you've only touched one folder.",
      "Gallery: missing photos are now tracked and tidied up. When a photo's file disappears from disk, it's hidden but kept (with its last-known thumbnail) on a new \"Missing photos\" page under Control panel → Libraries. A weekly cleanup permanently removes ones that have been missing longer than a grace window (default 30 days, configurable); photos still on disk are never touched.",
      "Ebooks: a scan rule can now target the whole library from its root folder, not just a subfolder.",
      "Face recognition: the window is wider, its Health tab scrolls instead of overflowing on long lists, and the duplicate-person avatars are larger and easier to compare.",
      "Metadata: FantLab lookups no longer hang when their server is slow, and show a clear \"try again later\" message when it's temporarily unavailable."
    ]
  },
  {
    version: "1.8.15",
    label: "Share photos with people, download whole sets, and a reworked album page",
    changes: [
      "Share photos with a specific person, not just a link: the photo-set Share dialog gained a People tab. Pick someone in the household, choose how long they get access (or no expiry), and the photos show up under their \"Shared with me\" — even for photos in a library they otherwise can't see. You can see who has access and revoke it anytime.",
      "Download everything at once: a shared photo link now has a \"Download all\" button that zips the whole set, and each album has a \"Download album\" option that zips the photos you can see.",
      "Shared links now say who shared them — \"So-and-so shared these photos with you\" — right at the top.",
      "Memories gained the Timeline's selection tools: tap to select photos, a Select button, and a per-year checkbox to grab a whole year at once. Date headers on both the Timeline (per day) and Memories (per year) now have a Share button to share that group's photos in one click.",
      "The album page was rebuilt: a bigger cover, the item count, and a tidy row of icon controls (a … menu, sort, and select). The … menu holds Rename, Set cover photo (now a photo picker), Download album, and Delete. Selecting inside an album lets you act on its photos in bulk.",
      "\"Add to album\" is now a searchable grid of album covers with dates instead of a cramped list — and album names no longer get cut off.",
      "Photo thumbnails are a bit larger across the gallery, and opening a photo no longer tucks the \"next\" arrow behind the details panel."
    ]
  },
  {
    version: "1.8.14",
    label: "The selection bar now stays with you",
    changes: [
      "When you're selecting photos, audiobooks, or ebooks, the action bar (Favorite, Add to album/collection, Share, Delete, and the like) now stays pinned to the top of the screen as you scroll, instead of scrolling off with the page. Its buttons are always within reach no matter how far down a long list you go."
    ]
  },
  {
    version: "1.8.13",
    label: "Albums, bulk actions, and share links for photo sets",
    changes: [
      "The gallery gets Albums — your own hand-picked photo sets, spanning every gallery library. A new Albums tab shows them as cover cards; inside, photos read chronologically (or in the order you added them — your choice), and open in the usual viewer. Everyone in the household can view an album; only the person who made it (and admins) can change it. Deleting an album never touches the photos.",
      "Adding photos is built for batches: select photos in the Timeline or Folders (day checkboxes select whole days) and use \"Add to album\" — or add a single photo from the viewer. The dialog can create a new album and add to it in one step.",
      "The selection bar gained more actions and stays pinned to the top while you scroll: Favorite the whole selection at once, add it to a collection, or share it (below) — and Select mode is now available to everyone, not just people who can delete.",
      "Share a set of photos with anyone via a quick link: select, hit Share, choose how long the link lives (1–30 days), and send it. No account needed on their end — they get a clean photo grid with a full-screen viewer (arrow keys work) and per-photo downloads. Links are snapshots of what you selected, only include photos you're allowed to share, and can be revoked anytime from the same dialog.",
      "Small fix: the viewer button that said \"Add to album\" while actually adding to a collection now says \"Add to collection\" — the new albums button sits right next to it."
    ]
  },
  {
    version: "1.8.12",
    label: "Gallery, day by day — a Memories tab, richer filters, and edit-in-place photo details",
    changes: [
      "The Timeline now groups photos by day (\"July 4, 2023\") instead of by month, and every day header has its own checkbox: one tap selects that whole day (and turns selection mode on), another deselects it. In selection mode only the photos you've picked show a check — no more wall of empty circles.",
      "Memories grew into a full view: a Memories tab (next to Timeline/Folders) with one section per year and date headings, where flipping through photos flows continuously from year to year. The strip cards on the Timeline are bigger, and both they and Home's \"On this day\" tiles now open the Memories view at that year.",
      "Filtering and sorting were reworked: the filter panel adds Media type (photos/videos) and Months (say, every July across all years — combine with a year to narrow to one), and the header dropdown now sorts the timeline by date taken or by date uploaded, with the day headers following whichever you pick.",
      "Opening a photo now shows its details right away, and you edit them right there: a pencil beside Description, Date, and Tags edits each in place (the separate edit window is gone; the name stays as-is). The folder line is clickable and jumps straight to that folder in the Folders view.",
      "Photos without a location can finally get one: click the map in the photo's details to drop a pin (drag to fine-tune), or remove a wrong one. Manually set locations survive library rescans — same as manually set dates — and the photo immediately shows up on the Map view and in the \"Has location\" filter. Your original files are never touched; edits live in the app's database.",
      "Fixed the \"Too Many Requests\" error when loading more and more of the timeline: thumbnails no longer eat into the request budget the app itself needs, so long scrolling sessions (and big People pages) stay smooth."
    ]
  },
  {
    version: "1.8.11",
    label: "Memories — \"On this day\" in the gallery and on Home",
    changes: [
      "The gallery Timeline now opens with a Memories strip: photos taken on today's date in past years, one card per year (\"2019 · 12 photos\"). Tap a year to flip through that day's photos in the lightbox. If nothing was taken exactly on this date, it looks a few days around it — and failing that, this month in past years — and the heading tells you which (\"On this day\", \"Around this day\", \"This month over the years\").",
      "The Home dashboard gets its first gallery row: \"On this day\" tiles, one per year, that jump straight into the gallery. It only appears when there really are photos from this date in past years — no filler.",
      "Memories follow your clock, not the server's: the date that counts as \"today\" is the one on the device you're looking at."
    ]
  },
  {
    version: "1.8.10",
    label: "A usable People page — and a way to spot split-up people",
    changes: [
      "The People page no longer chokes when there are lots of faces. With hundreds or thousands of people it used to fire off every avatar thumbnail at once — tripping the server's \"Too Many Requests\" limit, so a wall of person cards came up blank/broken. People now load a page at a time (with a \"Show more people\" button), avatars are kept by your browser instead of re-fetched on every visit, and if one can't load you get a tidy placeholder instead of a broken-image icon.",
      "New \"Health\" check for face grouping (People → Face recognition → Health, admin only). Face grouping is deliberately cautious — it would rather split one person into two groups than merge two people by mistake — so the same person can end up spread across several clusters. This tool measures exactly how often that's happening: it shows how many of your people have a look-alike cluster that's very likely the same person, a breakdown of how close those clusters sit to the automatic merge line, and a list of the most likely duplicates side by side with a one-click Merge for each. It's the answer to \"is it under-grouping, and which ones should I combine?\""
    ]
  },
  {
    version: "1.8.9",
    label: "All of a person's photos — and a much faster gallery",
    changes: [
      "Opening a person in the gallery now shows every photo they're in. Before, it stopped at the first 200 — so someone with thousands of photos looked like they only had a couple hundred. There's now a \"Load more\" button (like the Timeline), and the count at the top shows the real total.",
      "The gallery also stops choking on people and albums with lots of photos. Opening a big person could fire hundreds of thumbnail requests at once and trip the server's \"Too Many Requests\" protection, leaving the app stalled for a minute or two before it recovered. Thumbnails you've already seen are now kept by your browser and reused instead of re-fetched every time, so scrolling back, reopening a person, and revisiting the timeline are instant and no longer flood the server."
    ]
  },
  {
    version: "1.8.8",
    label: "Right face on the person avatar",
    changes: [
      "Fixes a person sometimes showing the wrong face as their avatar — a different person entirely — even though their photos were grouped correctly. The avatar was picked purely by how sharp/large the detected face was, so a crisp bystander from a group photo (or the odd mis-grouped face) could win. It now picks the clearest face that actually looks like that person (closest to the group's average), so the avatar matches the people inside. New scans get the right avatars automatically; to refresh avatars on libraries you've already scanned, use \"Regroup people\" in the Face recognition window once."
    ]
  },
  {
    version: "1.8.7",
    label: "Face grouping no longer freezes the site (and is far faster)",
    changes: [
      "Fixes the real cause behind the earlier reports of the site freezing during a face scan. After every photo was scanned, the app still had to GROUP the detected faces into people — and on a large library that step ran for minutes on the same thread that serves the website, so the site appeared frozen until it finished (and if you restarted during it, people never showed up). On a ~12,600-photo / ~9,700-face library this grouping step is now about 65× faster and, crucially, hands time back to the website while it works, so the app stays usable throughout. Existing detected-but-ungrouped faces are grouped automatically on the next startup — no rescan needed. Grouping results are unchanged; only the speed."
    ]
  },
  {
    version: "1.8.6",
    label: "Interrupted face scans no longer lose their people",
    changes: [
      "If a face scan was interrupted partway (a restart, a crash, a power blip) after it had finished detecting faces but before it grouped them into people, the People page could come up empty — as if the scan never ran, even though the work was done. The app now finishes that last grouping step automatically on the next startup, so your people show up without needing to rescan everything. (Combined with the responsiveness fix in 1.8.4, interrupted scans should be far rarer to begin with.)"
    ]
  },
  {
    version: "1.8.5",
    label: "Clearer connection banner",
    changes: [
      "The \"No internet connection\" banner now tells the truth about what's wrong. It only says that when your device has actually lost its network; when your device is fine but the server isn't answering (restarting, or briefly busy), it now says \"Server not responding\" instead — which is the accurate message for a home-hosted app that doesn't need the internet. It also waits for two missed check-ins before showing anything, so a single slow moment no longer flashes the banner."
    ]
  },
  {
    version: "1.8.4",
    label: "Face scans no longer freeze the site",
    changes: [
      "The site stayed responsive… except while faces were being scanned, when it could crawl or appear frozen until the scan finished. The scan was using every CPU core for the whole run, leaving nothing for the web server. It now deliberately keeps one core free, so the app stays usable while a scan runs in the background — the scan just takes a little longer. If you want to tune this, the FACE_ORT_THREADS setting controls how many CPU threads a scan may use (set it to 1 to be gentlest on the machine)."
    ]
  },
  {
    version: "1.8.3",
    label: "Tasks page fixes: accurate durations, batched rescans, tidier history",
    changes: [
      "Task durations are honest now. A task that waited in the queue behind others used to show the whole wait as its run time; the Started time and Duration on the Tasks page now measure from when the task actually began running.",
      "\"Rescan\" for faces now works in visible batches, just like turning face recognition on does. Instead of one long opaque job, a rescan queues numbered batches (\"batch 2 of 5\") you can watch progress through — and a run still pauses after 3 hours and continues the next night. Your named people and manual tags are kept; each photo's detected faces refresh as its batch runs.",
      "The finished-task history is easier to read. A long result or error message now wraps onto multiple lines within its column instead of stretching the row into one cramped line.",
      "No more overlapping scans. Starting a face scan while one is already running (or queued) is now refused with a clear message, and the nightly scheduled scans skip themselves if a library or face scan is still running — they run again at their next scheduled time rather than stacking up."
    ]
  },
  {
    version: "1.8.2",
    label: "Security hardening for the photo & video folder view",
    changes: [
      "Closed a small denial-of-service opening in the gallery's folder browser: a specially crafted folder-path request could make the server do a lot of needless work. The path is now trimmed with a fast linear scan and capped in length, so browsing behaves exactly as before while the expensive case is gone. No action needed on your part."
    ]
  },
  {
    version: "1.8.1",
    label: "Fixes the 1.8.0 image failing to start",
    changes: [
      "The 1.8.0 Docker image could crash immediately with \"Cannot find module 'detect-libc'\" — the image-slimming step trusted npm's dev-dependency labels, which wrongly marked two of the image processor's runtime libraries as removable. The build now keeps exactly the server's production dependency tree (computed from the lockfile), and a new build-time check imports every runtime dependency before an image can publish — so this class of breakage can't ship again. If you hit the crash, just update to this version."
    ]
  },
  {
    version: "1.8.0",
    label: "Gallery search with advanced filters, BMP photos fixed, slimmer Docker image",
    changes: [
      "The photo & video timeline now searches and filters like the audiobook catalog. The search box matches titles, captions, folder and file names, and named people. The new Filter button adds People, Years, an exact Date-taken range, Tags, Cameras, File size, and Location (has / has no GPS) — filters combine, every active one shows as a removable chip, and filtering from the Folder view jumps you to the matching Timeline results.",
      "Old BMP photos finally show up properly. Bitmap files (and any other format the image engine can't read) are now converted through the bundled ffmpeg, so they get grid thumbnails, lightbox previews, dimensions — and faces. Existing BMP items heal on the next library scan, no manual work needed.",
      "Empty files no longer appear as broken photos. A zero-byte file (usually a failed copy) is skipped by the scan and cleaned out of the gallery if it was indexed before; if the file ever gains content, the next scan picks it up.",
      "The Docker image lost about 700 MB. It now ships only production dependencies and only this platform's binaries — nothing changes in how you run it, the download and the disk footprint are just much smaller.",
      "Deleting a library now also reclaims the thumbnails it generated, instead of leaving them behind in the data folder.",
      "Face scanning can try a GPU (experimental). Set the FACE_ORT_PROVIDERS environment variable (e.g. \"dml,cpu\" on a Windows machine) to run face detection on an accelerator; the scan falls back to CPU automatically — at startup or even mid-scan — if the GPU can't handle the models."
    ]
  },
  {
    version: "1.7.2",
    label: "Face recognition housekeeping: disk cleanup, unreadable photos, leaner nights",
    changes: [
      "Face-crop images no longer pile up on disk. The little face avatars are now deleted whenever their photo is rescanned, trashed, or its face data is cleared — and \"Regroup people\" additionally sweeps out any leftovers from before this update, reporting how many it removed on the Tasks page.",
      "Photos that can't be read stop clogging the scan. A photo that fails to process (a corrupt or unsupported file) is now retried up to 3 times — always after every fresh photo — and then set aside instead of being re-attempted night after night. The Face recognition window shows these as \"unreadable\" next to the scan progress; a full Rescan gives them another chance.",
      "Nightly face scans got much cheaper. Regrouping people now happens once at the end of a scan run, and only when something actually changed — a night with no new photos finishes in moments instead of re-grouping every library for nothing.",
      "Person avatars behave. Removing someone from a photo (\"not this person\") also removes that face as their avatar, avatars never show a face from a library you don't have access to, and a hidden person can no longer be opened by a direct link. Database note: this release adds columns to a face-scan table without a migration — recreate the database (it rebuilds and rescans on start) or clear face data and rescan."
    ]
  },
  {
    version: "1.7.1",
    label: "Face-scan batches visible up front",
    changes: [
      "The Tasks page now shows a face scan's whole backlog the moment it starts. An initial or nightly scan is queued as numbered batches of 1,000 photos — \"Face scan · batch 1/3\" running, the rest waiting in the Queued list — so you can see exactly how much work is lined up and how far along it is. Each finished batch is recorded in the history with its own counts, and the nightly job's log line reports how many batches it queued.",
      "Batches stay honest about change: photos added or removed while a scan runs are picked up (or skipped) automatically, and if the 3-hour nightly window runs out, the remaining queued batches step aside and the next night picks up where things left off."
    ]
  },
  {
    version: "1.7.0",
    label: "Nightly library scans, a new Tasks page + smarter face grouping",
    changes: [
      "Your libraries now stay fresh on their own. Three new scheduled jobs scan audiobook, ebook, and photo & video libraries every night, each at its own randomized quiet-hours time (between 01:00 and 04:59) so they don't all start at once. And schedules are fully editable now — pick the day of the week (weekly), day of the month (monthly), and the exact time for every job under Control panel → Libraries → Scheduled jobs.",
      "\"Job logs\" is now Tasks. Running tasks show a circular progress indicator with live counts and an estimated time remaining (\"1,200 of 5,000 items · 24% · about 40 min left\"), queued tasks list their position in line, and the finished history is paged. Photo, ebook, and face scans all report live progress now — and the estimate is based on the recent scanning rate, so it stays honest even when a scan races through already-cataloged files first.",
      "One heavy task at a time. Library scans and face recognition now run strictly one after another instead of competing for CPU and disk — whatever else is triggered simply waits in the queue and starts the moment the current task finishes.",
      "Face grouping fights fragmentation. Groups of the same person that clearly belong together are now merged automatically after every scan, your manual merges are permanent (reclustering re-unites them instead of splitting them back apart overnight), and stray one-photo groups fold into the right named person. Existing fragments start consolidating on the next scan or Regroup — no rescan needed.",
      "Face scanning is polite about big backlogs. The nightly face scan now runs last (05:00, after the library scans, so tonight's new photos get their faces tonight), works in batches of 1,000 photos with people appearing progressively after each batch, and pauses after 3 hours — the remainder continues the next night automatically. Manual full rescans still run to completion. Live scan progress now lives on the Tasks page; the Face recognition window points you there."
    ]
  },
  {
    version: "1.6.1",
    label: "Automatic maintenance schedules + tidier face-recognition window",
    changes: [
      "Maintenance now runs itself. The upkeep tasks under Control panel → Libraries → Scheduled jobs come switched on with sensible schedules — a nightly scan for faces in newly added photos (01:00), plus weekly job-log cleanup (00:30) and recycle-bin emptying (00:45). The face scan only touches new or not-yet-current photos, so it's cheap when nothing has changed. Change the frequency or turn any of them off whenever you like.",
      "Tidier Face recognition window. The per-library switches and the grouping-strength control are now split into two tabs, and the library list scrolls when you have many libraries. Grouping strength also now defaults to its strongest setting, for cleaner, more consolidated people with the new model. A note marks the feature as experimental — grouping isn't perfect, so expect to merge or rename people occasionally."
    ]
  },
  {
    version: "1.6.0",
    label: "Sharper face recognition + live scan progress",
    changes: [
      "Face recognition now uses a more accurate recognition model (ArcFace ResNet50). It's noticeably better at telling people apart across years, ages, and lighting, so the groups it makes are cleaner — especially in family photos that span a long time.",
      "One-time rescan needed after you update. Because the face model changed, existing face data doesn't carry across: open a gallery's People tab → Face recognition → Rescan to rebuild it (or turn on the new scheduled job below and let it happen automatically), then re-name anyone you'd already named. On a large library the first rescan is CPU-intensive and can take a while — it keeps running in the background, so you can close the window.",
      "Live scan progress. The Face recognition window now shows a progress ring with \"X of Y photos\" and an estimated time remaining while a scan is running, so you can tell it's working and roughly how much is left.",
      "Faster scans. All the faces in a photo are now recognised together in one pass instead of one at a time, which helps offset the heavier, more accurate model.",
      "New \"Scan new photos for faces\" scheduled job (Control panel → Libraries → Scheduled jobs). Switch it on to automatically find faces in newly added photos every day, week, or month. It only processes new or not-yet-current photos, so it's cheap when nothing has changed. Off by default."
    ]
  },
  {
    version: "1.5.0",
    label: "Scheduled maintenance jobs + control-panel tidy-up",
    changes: [
      "New Scheduled jobs tab (under Control panel → Libraries). Two built-in upkeep tasks — \"Clean job logs\" (trims the job history to the most recent 100) and \"Empty recycle bin\" — that you can switch on, set to run every day, week, or month, or trigger once with \"Run now\". Both are off by default.",
      "Control panel reorganised: the job history now lives under Libraries (as \"Job logs\", alongside Scheduled jobs), and Backup moved under Config. Old links still work.",
      "Face recognition: you can now remove all face data for a single gallery library — open a gallery's Face recognition window and use the new delete button (it asks first and explains exactly what's cleared). Your photos and any people who also appear in other libraries are kept. Rescan is now a compact icon too.",
      "Clearer on/off switches replace the old tick-boxes for automatic backups, scheduled jobs, and per-library face recognition.",
      "Library list polish: each library's Scan rules and Face recognition actions now lead the row and line up neatly across every library type."
    ]
  },
  {
    version: "1.4.2",
    label: "A stronger face-recognition engine (+ Credits page)",
    changes: [
      "Face recognition now runs on a stronger, industry-standard model — InsightFace's SCRFD detector plus ArcFace — entirely on your own server. It tells different people apart far more reliably and finds faces more thoroughly, so the groups it makes are noticeably cleaner.",
      "One-time rescan needed after you update. Because the underlying face model changed, your existing face data doesn't carry across: open a gallery's People tab → Face recognition → Rescan to rebuild it, and re-name anyone you'd already named (just once). On a large library the rescan is quickest when the app is started normally (a production start) rather than in development.",
      "Faster, steadier scans: each photo is now decoded a single time instead of several times per face, and a photo that fails to process is skipped and logged rather than being silently recorded as having no faces.",
      "New Credits tab on the About page, acknowledging the open-source projects this app is built on."
    ]
  },
  {
    version: "1.4.1",
    label: "Face recognition: sharper grouping, face thumbnails & fixes",
    changes: [
      "Much better grouping. Face recognition now keeps different people apart far more reliably — it no longer lumps several people into one group. The trade-off is that one person can appear as a few separate groups; combine them with Merge, and use the new \"Grouping strength\" slider in the Face recognition popup to make grouping looser or stricter, then press \"Regroup people\" to apply it (no need to rescan your photos).",
      "Person thumbnails now show the actual face. A group's icon is a close-up crop of the person's face instead of the whole photo, so you can tell who each group is at a glance. Existing libraries fill these in the first time you press Regroup.",
      "Turn face recognition on per library. The Face recognition popup on the People tab now has a switch for each gallery library plus a Rescan button, instead of a single global on/off.",
      "Removing a person from a photo now works properly — including faces the app detected automatically. Use the \"×\" on a photo in a person's page to take it out of that group, and it stays out even after a full rescan.",
      "Rescan now asks for confirmation and keeps your work: your names, manual tags, and the photos you've removed from named people are all preserved."
    ]
  },
  {
    version: "1.4.0",
    label: "People in your photos — tag faces and recognise them automatically",
    changes: [
      "New: a People view in the gallery. Open a photo's details and add the people in it — type a new name or pick someone you've added before — then browse your library by person from the new People tab, where each person shows as a card with how many photos they appear in. Tagging is per photo, so it stays quick.",
      "New (optional): automatic face recognition that runs entirely on your own server — nothing is ever sent to the internet. An administrator turns it on from the gallery's People tab and presses \"Scan for faces\"; the app then finds faces in your photos and groups the same person together for you. Each group starts out \"Unnamed\" — give it a name once and it becomes a person like any other.",
      "Tidy up what it finds: rename a group, merge two groups that are really the same person, or delete a group — your photos are never affected, they're just untagged. Naming a group keeps it learning, so a person you've named gathers their new photos automatically on the next scan.",
      "Private and off by default: face recognition only runs after an admin enables it, and the models it uses are bundled with the app, so there are no downloads and no outside services involved."
    ]
  },
  {
    version: "1.3.10",
    label: "Photo & video gallery",
    changes: [
      "New: a photo & video gallery. An administrator can add a Gallery library (Control panel → Libraries) pointed at a folder of photos and videos. Browse it three ways — a Timeline grouped by month (using each photo's date), a Folders view that mirrors your folders on disk, and a Map that plots geotagged photos and videos so you can see where they were taken. Opening one shows it full-screen with its details (date, dimensions, camera, location); videos play inline.",
      "Upload straight from the app. In a gallery you manage, the Upload button takes a batch of photos and videos — or a whole folder — and adds each as its own item, reading its date and building thumbnails automatically. Libraries that point at an existing read-only folder are never written to.",
      "Share a photo or video. Create a guest link anyone can open without an account to view and download a single photo or video, or share it directly with another person's account — the same sharing audiobooks and ebooks already had.",
      "Tidy up in bulk. A Select mode lets you tick several photos or videos and move them to the Recycle Bin in one go, where they can be restored.",
      "See where a photo was taken. A photo's details panel now shows a small map pinned to its location when the photo carries GPS data. Viewing any map loads map tiles from OpenStreetMap — the only thing the app ever fetches from the internet.",
      "New stats pages. Control panel → Status now has Ebook and Gallery stats alongside Audiobook stats — library sizes and counts, ebook formats, photo/video totals, and the largest items."
    ]
  },
  {
    version: "1.3.9",
    label: "Quotes & bookmarks that work in the installed app — even offline",
    changes: [
      "Quotes are reachable in the installed app. The Quotes page now appears in the phone app's Profile menu (and the desktop account menu), so you can get to everything you've saved without the desktop sidebar.",
      "Selecting text works reliably on phones and tablets. The highlight toolbar now appears dependably when you select a passage on a touch screen — previously you'd often get only the system's copy menu. The toolbar also sits clear of the screen edges.",
      "Highlight and bookmark while reading offline. If you're reading a downloaded book with no connection, the highlights and bookmarks you make are saved on the device and sync automatically the next time you're online — matching how your reading position already worked."
    ]
  },
  {
    version: "1.3.8",
    label: "Save quotes & highlights from your books",
    changes: [
      "Highlight as you read. Select any passage in the ebook reader and a small toolbar appears — pick a colour to highlight and save it, or copy the text. Your highlights stay marked on the page, and tapping one lets you recolour, copy, or remove it.",
      "A new Quotes page. Everything you've saved lives under My Library → Quotes, grouped by book. From there you can copy a quote, edit its note, jump straight back to the exact spot in the reader, or delete it.",
      "Bring in quotes from anywhere. Use \"Add quote\" to save a passage from any book — including ones that aren't in your library — by typing the text and the title and author yourself. If a book is later removed, its quotes are kept (with the title and author preserved) rather than lost."
    ]
  },
  {
    version: "1.3.7",
    label: "Reliable offline ebook reading & tidier collections",
    changes: [
      "Downloaded ebooks open reliably. Opening an ebook you'd saved for offline reading could fail with a hard-to-read \"could not load\" message, even while online. Saved ebooks now open straight from the downloaded copy every time, and any reader error is now clearly legible instead of washed out.",
      "Collections look right on phones. On a collection's page the title no longer gets squeezed next to the \"Play all\" and \"Delete\" buttons — those drop onto their own line — each book's controls move to their own row so the title stays readable, and the empty book placeholder icon is gone.",
      "Read button for ebooks in a collection. Ebook entries in a collection now have a Read button that jumps straight into the reader, matching the Play button audiobooks already had."
    ]
  },
  {
    version: "1.3.6",
    label: "Layout fixes for tablets & phones",
    changes: [
      "Tablets keep the left menu. On iPad-sized screens (and other tablet widths) the navigation no longer collapses into an awkward strip across the top — the familiar left sidebar stays put, and only actual phones switch to the bottom tab bar.",
      "Long menus scroll instead of overlapping. When a side menu is taller than the screen (e.g. the Control panel on a short window), the menu now scrolls on its own while Logout and the footer stay pinned at the bottom, so nothing overlaps or gets pushed off-screen.",
      "Tidier book rows. Fixed a glitch where the tops of the next row of book covers could peek out below the \"Continue\" and \"Recently added\" rows on some screen sizes; each row now ends cleanly on one line.",
      "Theme picker fits phones. On the Profile → Appearance page, the theme tiles now lay out as two neat columns on a phone instead of cutting a third tile off the edge."
    ]
  },
  {
    version: "1.3.5",
    label: "A real installed-app experience on your phone",
    changes: [
      "Pick up where you left off, front and center. On phones, the Home screen now opens with a large \"Continue listening\" / \"Continue reading\" card for your most recent in-progress book — one tap to jump straight back in, with a Save-for-offline button right on the card.",
      "A true offline Home. When your phone has no connection, the installed app's Home screen now shows just the books you've saved to the device — ready to play or read — instead of a page of covers it can't load.",
      "Phone navigation that behaves like an app. The bottom tab bar (Home · Media · Offline · Profile) now stays put on the Downloads and account pages, and the Profile tab opens a quick sheet with your account and library shortcuts (Favorites, Bookmarks, Collections, Shared with me, and sign-out). The duplicate top menu on small screens is gone.",
      "An easy way out of the player. The full-screen player on phones now has a back button in the top-left, so you can step back to where you were — previously there was no on-screen way to leave it.",
      "Cleaner Home, consistent lists. The Home screen now shows your 5 most recent in-progress books and 10 newest additions, with the full lists one tap away under \"View all\" — and those lists now match the Home screen's look on phones. Also refined the pop-out audiobook player controls."
    ]
  },
  {
    version: "1.3.4",
    label: "Sidebar quick-links & a new Help page",
    changes: [
      "New Help page, plus quick links in the sidebar. Every page's side menu now ends with a small footer — Logout, plus one-tap icons for About, Help, and Report a bug. The new Help page gathers the user guides (two-factor sign-in, putting your library on the internet) and a direct \"report a bug\" link to GitHub all in one place.",
      "Tidier, more consistent navigation. The main side menu is a little more compact, and the main, Control panel, and account/library menus now share the same row sizing so things feel consistent as you move around. (Logout now lives in the sidebar footer instead of the account drop-down menu.)"
    ]
  },
  {
    version: "1.3.3",
    label: "Refreshed navigation & consistent tabbed layouts",
    changes: [
      "Your library and account pages now use a left-hand menu — the same style the Control panel uses. Profile, Favorites, Bookmarks, Collections, Shared with me, and Downloads are grouped under \"Account\" and \"My Library\" in the sidebar, replacing the old row of tabs across the top of the page.",
      "Polish: the Profile, Config, and Security pages now share one tabbed layout. Each has a heading with an icon and a short description, and every tab carries its own icon. Nothing moved — the same settings are in the same places — it's just easier to scan and visually consistent across the app."
    ]
  },
  {
    version: "1.3.2",
    label: "Admin sign-in unlock & clearer auth logs",
    changes: [
      "New (admin): unlock a locked account without waiting. After too many failed sign-ins an account is temporarily locked; Control panel → User management now shows a red \"Locked\" badge on that account with an Unlock button, so you can clear the lockout and let the person try again right away instead of waiting it out.",
      "The activity log now records which email address a failed or refused sign-in was for, so you can tell which account someone was trying to reach — useful for spotting who's locked out or being targeted."
    ]
  },
  {
    version: "1.3.1",
    label: "Fix: container could fail to start (two-factor dependency)",
    changes: [
      "Fixed a packaging bug in the 1.3.0 container image: a two-factor sign-in dependency (otplib) was missing from the published image, so the app could crash on startup with a \"Cannot find package 'otplib'\" error before it finished loading. The image now bundles it. If you ran into this, just update to 1.3.1 — there's nothing to configure and no data is affected."
    ]
  },
  {
    version: "1.3.0",
    label: "Security: two-factor sign-in & internet-ready hardening",
    changes: [
      "New: two-factor authentication (2FA). Add a one-time code from an authenticator app (Google Authenticator, Authy, Apple Passwords, 1Password…) to your sign-in, so a stolen password alone can't reach your account. Turn it on under Profile → Two-factor authentication: scan the QR code, enter a code to confirm, then save the backup codes it shows (each works once if you ever lose your phone). You can regenerate the codes or turn it off at any time. Locked out with no phone and no backup codes? An admin can reset it for you from Control panel → Users.",
      "New: a Security page in the control panel (admin) that gathers the new protections in one place. Accounts now lock for a while after several failed sign-ins, and an IP address that keeps failing is blocked automatically — the thresholds (how many tries, how long) are adjustable there. You can also block or unblock specific IPs by hand, mark trusted home-network ranges that skip the extra checks, and set a password policy (minimum length, and optionally requiring a mix of letters, numbers and symbols) that applies whenever a password is set.",
      "New: suspicious-activity email alerts. When email is set up, admins are notified about things worth a look — an account getting locked, an IP being auto-blocked, a new administrator account, or two-factor being turned off. (Configure email under Control panel → Config → Email.)",
      "Hardening so the library can be opened to the internet safely: enforced browser security headers (Content-Security-Policy and friends), CSRF protection on every change you make, sign-in rate limiting, and a TRUST_PROXY_HOPS setting so the per-IP protections see the real visitor when you run behind a reverse proxy. A new guide — docs/users/exposing-to-the-internet.md — walks through doing it properly (HTTPS, secure cookies, proxy setup), and a bundled dependency carrying security advisories was updated.",
      "Everything here is optional and off by default, so a home-network install is unchanged until you choose to turn it on."
    ]
  },
  {
    version: "1.2.15",
    label: "Send to e-reader, sleep timer & email change",
    changes: [
      "New: send any ebook to your Kindle or Kobo by email. Open an EPUB or PDF book's page and choose Send to e-reader, and it arrives on your device. Setup is two steps: an admin fills in the server's email (SMTP) details under Control panel → Config → Email and sends a test, and each person adds their own e-reader address — for example you@kindle.com — under Profile → Send to e-reader. For Kindle, also add the server's sender address to Amazon's approved-senders list. EPUB and PDF can be sent.",
      "New: a sleep timer in the audiobook player. Tap the moon button next to the speed control and pick 15, 30, 45 or 60 minutes, or End of chapter — playback pauses when the time is up, the button shows a live countdown, and the timer pauses whenever you pause.",
      "You can now change the email address you sign in with. Under Profile → Email, choose Change email and confirm with your current password; your other devices stay signed in."
    ]
  },
  {
    version: "1.2.14",
    label: "Custom scan rules",
    changes: [
      "New: custom scan rules for ebook libraries. When a folder is organised its own way — say Author / Series / \"01. Title\" — you can teach the scanner that exact shape instead of living with the default grouping. Open Control panel → the ebook library → Scan rules, give the rule a name, browse to the folder(s) it should cover, then describe the layout with a pattern made of {author}, {series}, {position} and {title} tokens (there are ready-made presets and a click-to-insert palette). A Preview button dry-runs the pattern over the real files so you can see how each book will be read before you save. Rules apply on the next rescan.",
      "The rule editor is split into two clear tabs — \"Name & folders\" and \"Rule\". A Browse-folders button opens a picker rooted at the library, and the folders you choose appear as a grid below, each removable with one click.",
      "Matching copes with how files are really named: \"1. Title\" and \"1.Title\" (no space after the number) are both understood, while genuine decimals like \"2.5\" stay intact. If a folder nests an extra level — for example a \"universe\" folder holding several sub-series — add a second rule on that deeper folder and use the {ignore} token to skip the wrapping level."
    ]
  },
  {
    version: "1.2.13",
    label: "Ebook metadata, bulk edit & FantLab",
    changes: [
      "FB2 ebooks now have their author, title, year, genres (as tags), description and cover read from the file during scanning — previously only EPUBs were read, so FB2-only libraries showed bare filenames with no author or tags to filter by. Books saved in the older windows-1251 Russian encoding are decoded correctly too. Heads up: existing FB2 books won't gain this until you rescan that ebook library (Control panel → the library → Rescan); newly added FB2 files are read automatically.",
      "Edit several ebooks at once: on the Ebooks page choose Select, tick the books, then \"Edit metadata\" to overwrite author, category, language, tags or description across all of them — the same bulk editor audiobooks already had. The editor is a little wider now and keeps Tags on their own tab.",
      "Fixed Metadata Lookup for FantLab: search returns results again, titles that start with a number like \"1. …\" now match, and you can paste either a work link (fantlab.ru/work…) or an edition link (fantlab.ru/edition…).",
      "Filter panels show a search box as soon as a list has more than one option, so authors, tags and categories are quick to find in the Ebooks filters too — not just the long audiobook lists.",
      "Smaller touches: new libraries default to no owner (a \"system\" library) rather than being owned by you, and the Upload, Select, Filter and Sort controls at the top of the Audiobooks and Ebooks pages are now compact icons."
    ]
  },
  {
    version: "1.2.12",
    label: "Read FB2 ebooks",
    changes: [
      "FB2 ebooks now open in the in-app reader, the same as EPUB — with the table of contents, search, bookmarks, themes, and reading-position sync all working the same way. Until now an FB2 book could only be downloaded. PDFs still open in their own viewer.",
      "FB2 books can also be saved for offline reading on a phone or tablet, just like EPUB."
    ]
  },
  {
    version: "1.2.11",
    label: "Book editions & multi-format ebooks",
    changes: [
      "Group different versions of the same book as editions. On the Audiobooks or Ebooks page choose Select, tick the books that belong together, and use \"Group as editions\", naming the one that should lead. The library then shows the group as a single cover — with a small editions badge — instead of several look-alike duplicates, and the book's page gains an Editions switcher to flip between them. Each edition keeps its own details (a different translation, publisher, year, or narrator) and its own reading or listening position.",
      "An edition group can mix an audiobook and an ebook of the same title, so one book can offer both Listen and Read. From the book's page you can change which edition leads, or remove one from the group — removing the last pair ungroups them.",
      "Ebooks that come in several file formats — say EPUB, PDF, and FB2 of the same book — are now one book with multiple formats rather than separate entries. New ebook libraries now scan EPUB, PDF, FB2, MOBI, AZW3, TXT and RTF; the scanner groups files that share a name in one folder, the book's page lists every format under Files, and Read opens the best one for in-app reading (EPUB, then PDF) while the rest are there to download. Reader apps over OPDS now get one entry per book offering every format.",
      "Heads up for ebook libraries you already have: existing ebooks keep working untouched. To merge format-duplicates you already catalogued, rescan the ebook library once — that re-catalogs it fresh, so its reading positions, favourites, and bookmarks reset (your files on disk are never touched). Newly added ebooks group their formats automatically."
    ]
  },
  {
    version: "1.2.10",
    label: "One Authors page for everything",
    changes: [
      "Authors now live on a single page that spans your whole library, with an All / Audiobooks / Ebooks filter — just like categories. The separate per-section author lists are gone; Authors is in the main menu now (and the shortcuts inside Audiobooks and Ebooks still take you there).",
      "Clicking an author or narrator anywhere — including on a book's page — opens their unified page showing everything they made across audiobooks and ebooks."
    ]
  },
  {
    version: "1.2.9",
    label: "Unified author pages",
    changes: [
      "Authors and narrators now have one combined page that brings together everything they made across your library — their audiobooks and ebooks side by side, grouped by role (author, narrator). Before, the same person showed up as separate entries under audiobooks and ebooks.",
      "You can still browse Authors and Narrators from each section as before; every link now opens this unified person page, and your existing author links and bookmarks keep working."
    ]
  },
  {
    version: "1.2.8",
    label: "Smarter audiobook folder scanning",
    changes: [
      "With \"Treat folder as book\" turned on, a folder named like \"Author - Title [Narrator]\" is now read for its author, title, and narrator — so books organised that way get the right people even without embedded tags or an online lookup.",
      "Cover art is now picked up from TIFF (.tif) images and from a sidecar art folder (Covers/, Artwork/, …) next to the book, not just JPEG/PNG inside the book folder — handy for CD rips that keep scans separate."
    ]
  },
  {
    version: "1.2.7",
    label: "Ebook sharing",
    changes: [
      "You can now share ebooks just like audiobooks — create a guest link anyone can open without an account, or share a book directly with another person's account.",
      "Opening a shared ebook link shows the cover and title with Read and Download buttons: Read opens the book right in the browser (the reader for EPUBs, the built-in viewer for PDFs), no app or sign-in needed.",
      "Ebooks shared directly with your account now appear under \"Shared with me\" alongside shared audiobooks and open in the reader with your own reading position."
    ]
  },
  {
    version: "1.2.6",
    label: "Reader & offline screen redesign",
    changes: [
      "The ebook reader has a cleaner menu on phones and the installed app: a back button up top alongside quick Search, text size (Aa), theme, bookmark, and settings controls, plus a slim bottom bar showing chapters, a progress slider, and the current page.",
      "The reader's settings now carry the full set of options — theme, font, text size, line spacing, and page direction — and the desktop reader uses the same layout with the book cover and title centred.",
      "The Offline screen now lists downloaded books in the same one-book-per-row layout as the home screen, grouped under Audiobooks and Ebooks headings, each row with a one-tap delete button to free up space."
    ]
  },
  {
    version: "1.2.5",
    label: "Default covers, reader access & library fixes",
    changes: [
      "Audiobooks and ebooks without their own artwork now show a clean default cover — a blue headphones card for audiobooks and an orange book card for ebooks — across the library grids, book pages, the player, and the home screen.",
      "Reader access (OPDS) has moved from your Profile to Control Panel → Config, so reader tokens are now managed by an administrator in one place.",
      "A user or group can now own more than one library.",
      "Audiobook player: multi-file books now show the position as a track number instead of a chapter number (books with real embedded chapters still show chapters).",
      "Scanning a library whose source folder is missing or unreadable now stops right away with a clear error, instead of appearing to scan indefinitely."
    ]
  },
  {
    version: "1.2.4",
    label: "Library setup wizard refresh",
    changes: [
      "The Add library wizard now has a cleaner three-step flow: choose the library type, enter the core details, then review the settings before scanning.",
      "Advanced library setup now opens inside the parent wizard as a bottom-up overlay with Access, Upload, and Scanning tabs, plus Save and Cancel actions.",
      "The Details step is more focused: folder selection, owner, and public/private visibility are directly on the page, while advanced scan/upload options stay tucked away until needed."
    ]
  },
  {
    version: "1.2.3",
    label: "Mobile library & offline polish",
    changes: [
      "Audiobooks and Ebooks on phones / the installed app now use the same clean one-book-per-row layout as the home screen — cover, progress, run time or format, a play/read button, and a three-dot menu with the full library actions (favourite, mark played/read, add to collection, download, edit, delete).",
      "The mobile library header is now a compact icon row (search, filter, sort, upload) with a Browse menu for authors, narrators and series.",
      "Offline reliability: downloaded ebooks open in the reader while offline, covers are saved for offline viewing, and a progress bar shows while a download is still running."
    ]
  },
  {
    version: "1.2.2",
    label: "Faster offline detection",
    changes: [
      "The online/offline indicator now updates promptly when the server becomes unreachable, instead of waiting on the browser's slower built-in network check."
    ]
  },
  {
    version: "1.2.1",
    label: "Mobile home & app navigation",
    changes: [
      "The home screen on phones and the installed app was rebuilt: in-progress and recently-added books now appear as a clean one-book-per-row list with cover, progress bar, run time, and a play or read button.",
      "New four-tab bottom navigation — Home, Media, Offline, Profile — with a Media menu to switch between Audiobooks and Ebooks.",
      "Save a book for offline straight from the home list, open ebooks in the reader or audiobooks in the player with one tap, and see an online/offline indicator in the header."
    ]
  },
  {
    version: "1.2.0",
    label: "Profile, theme & bookmarks refresh",
    changes: [
      "Your account settings now live in one place: change your password and pick your theme right on the Profile page. Changing your password signs your other devices out automatically.",
      "Bookmarks were redesigned around the books they belong to. Bookmarks are grouped under each book (collapsed by default, with an audio or ebook badge), and every saved spot shows its chapter, position, and your note in a compact row — with a Read or Play button to jump straight back in, next to remove.",
      "The Favorites, Downloads, and Shared-with-me tiles now show a clear remove button.",
      "Tidied the Control Panel: the Gallery and Other Media placeholders are gone. New library types are added through the library wizard and managed under Libraries."
    ]
  },
  {
    version: "1.1.0",
    label: "Read on any device (OPDS)",
    changes: [
      "Your ebook library is now available over OPDS — the open catalog standard that reader apps speak — so you can browse and download your books in apps like KOReader, Moon+ Reader, Librera, and Thorium, including on e-ink devices such as Kobo and Kindle that the in-app reader can't reach.",
      "Set it up under Profile → Reader access (OPDS): create a token for each device, then paste its catalog link into the reader, or scan the QR code on a phone. If your reader asks for a username and password instead, the same token works as the HTTP Basic password.",
      "Each token is read-only and only ever sees the libraries you can already access — it is never your account password, and you can remove a device's token at any time without affecting your other devices.",
      "Browse the catalog by recently added, all books, author, category, or language, search the whole library, and download a book straight into your reader."
    ]
  },
  {
    version: "1.0.1",
    label: "Security hardening",
    changes: [
      "Rate limits applied to the two public invite endpoints (the link preview and the account-creation form) to prevent scripted abuse."
    ]
  },
  {
    version: "1.0.0",
    label: "Rebuilt library foundation",
    changes: [
      "Heads up before you update: this release rebuilds the library database on a new, cleaner foundation, and it does not carry the old data across. After updating, your libraries will look empty — open each one and run a scan to re-catalogue it from your files. Your audiobooks and ebooks on disk are never touched, so a scan brings everything straight back. Listening and reading progress, bookmarks, collections, favourites, and shares start fresh.",
      "Audiobooks, ebooks, and future media types now share one common foundation. Every library type gets the same categories, tags, collections, favourites, sharing, and search, and new types can be added later without disturbing what's already there.",
      "Authors and narrators are now shared across the whole app, so the same person's photo and biography show up everywhere they're credited — not just inside one library.",
      "A lot of behind-the-scenes tidying for reliability and consistency: one uniform way of recording dates and times across the app, and a cleaner data model that's faster to build on going forward."
    ]
  },
  {
    version: "0.31.0",
    label: "New EPUB reader",
    changes: [
      "The EPUB reader has been rebuilt from the ground up on a modern rendering engine. Chapter navigation that used to fail or jump to the wrong place on some books now works everywhere — the table of contents, the current-chapter title, and the reading progress all track the book reliably.",
      "A cleaner, immersive reading view: a centered page with adjustable text size and font (serif or sans), line spacing, and light, sepia, or dark themes. Switch between one-page, two-page, and continuous-scroll layouts, jump anywhere with the progress slider, and see an estimated time remaining.",
      "Full-text search across the whole book, plus bookmarks you can add, note, and jump back to.",
      "Open a book straight into the reader from its tile on the Ebooks page, and mark an ebook as read or unread from both the tile and the book's detail page — mirroring how audiobooks work."
    ]
  },
  {
    version: "0.27.0",
    label: "Home dashboard: Continue & Recently added",
    changes: [
      "The home page now opens on your real library instead of placeholder tiles. A \"Continue listening & reading\" row gathers the audiobooks and ebooks you're partway through — most recently played or read first — and a \"Recently added\" row shows the newest titles, both spanning audiobooks and ebooks together.",
      "A slim overview strip across the top links straight to your Audiobooks, Ebooks, in-progress books, and Favorites, each with a live count.",
      "Each row's \"View all\" opens a full cross-library page — Recently added or Continue — that lists the latest items across the whole digital library, using the same cover tiles as the Audiobooks page."
    ]
  },
  {
    version: "0.26.0",
    label: "Audible metadata provider",
    changes: [
      "Audible is now a metadata source in a book's Metadata Lookup — search it directly or as part of \"All providers\", or paste an Audible link. It's the richest source for audiobooks and the most reliable for the narrator, the Audible ASIN, and high-resolution cover art.",
      "Audible results work everywhere a provider result does: the current-vs-result comparison, applying details, and the Cover tab's online cover search."
    ]
  },
  {
    version: "0.25.0",
    label: "Lookup compare, paste-a-link & manual people",
    changes: [
      "Metadata Lookup can now expand any search result into a side-by-side comparison with the current book, so you can see exactly which fields — title, authors, narrators, year, description, cover and more — a result would change before you apply it.",
      "Paste a book link from Open Library, Apple Books, FantLab, or LibriVox to pull metadata straight from that specific page instead of searching.",
      "The Cover tab can search those same sources for cover art and apply just the cover, leaving the rest of the book's metadata untouched.",
      "Author and narrator profiles get the same treatment: \"Find online\" now previews a current-vs-found comparison of the biography and photo (paste a Wikipedia or Open Library author link to target a specific page), and a new \"New author\" / \"New narrator\" button lets you add a person by hand."
    ]
  },
  {
    version: "0.24.1",
    label: "m4b scan fix & chapters tab",
    changes: [
      "Fixed a scan that could hang on some m4b audiobooks while reading their embedded chapters.",
      "The book details page gained a Chapters tab that lists a book's embedded chapters."
    ]
  },
  {
    version: "0.24.0",
    label: "m4b chapter reading & navigation",
    changes: [
      "Embedded chapters inside m4b (and MP3) audiobooks are now read during the scan, so a single-file book shows its real chapter list instead of one long track.",
      "The player and the book page let you jump between those chapters and show where you are within them."
    ]
  },
  {
    version: "0.23.0",
    label: "Recycle bin & restore",
    changes: [
      "Deleting a catalogued audiobook or ebook is now a soft delete: its files move into a hidden per-library .trash folder and the item leaves the catalog, but it can be restored until you remove it for good.",
      "A new Recycle Bin in the Control Panel lets you restore items, delete them permanently, or empty the bin, and deleted items auto-purge after 30 days (configurable).",
      "Per-item delete now works for ebooks too, from the book detail page."
    ]
  },
  {
    version: "0.22.0",
    label: "Online metadata lookup, LibriVox & author photos",
    changes: [
      "A new optional \"Online lookup\" scan source fills in missing narrator, description, cover, year, and genres from LibriVox (with an Open Library fallback) while scanning, and fetches author and narrator photos and bios from Wikipedia and Open Library.",
      "LibriVox joined the manual metadata search, and person profiles gained a \"Find online\" button with a photo candidate picker.",
      "Authors and narrators now show their photos and biographies on their list and detail pages."
    ]
  },
  {
    version: "0.21.0",
    label: "Folder upload & companion files",
    changes: [
      "You can now upload a whole book folder (file picker or drag-and-drop): subfolders flatten into ordered track names, the folder name becomes the book title, and unrelated files are skipped just like a scan.",
      "Companion files (covers, metadata sidecars, documents) are now a per-library setting you can edit in the create wizard and edit dialog; uploads accept your scan extensions plus the configured companions.",
      "Fixed uploads being rejected over 1 MB, so real audiobooks and backups upload again — the library's maximum upload size is now the only limit."
    ]
  },
  {
    version: "0.20.0",
    label: "Audiobook upload & delete",
    changes: [
      "Upload audiobooks straight from the Audiobooks page — multi-file, one book per upload — staged and then scanned in automatically.",
      "Delete books from the catalog individually or in bulk, removing the folder on disk, its cover art, and all database rows.",
      "Both are permission-gated (contributors can upload, managers can delete) and refused on external read-only libraries."
    ]
  },
  {
    version: "0.19.0",
    label: "Control Panel management refresh",
    changes: [
      "The Control Panel management pages now share the same compact datagrid layout and page-icon headers across Libraries, Users, Groups, Invite links, Sessions, Storage, and Logs.",
      "User management gained manual account creation, profile editing, and admin password changes, with password updates revoking the user's other active sessions.",
      "Library Take ownership now asks for confirmation before granting manager access, and Groups now treats membership as plain membership so library roles remain the source of access control."
    ]
  },
  {
    version: "0.18.0",
    label: "Upload a backup file",
    changes: [
      "The Backup screen can now take a backup file from your computer: click \"Upload backup\", then drop or pick a full .zip (database + cover art) or a database-only .sqlite. It's checked to be a real isputnik backup, added to the list, and restored like any backup made here — handy for moving a library between machines.",
      "Under the hood this is a new shared upload component — drag-and-drop, a live progress bar, and files streamed straight to disk — that future upload spots (library media, and more) will reuse.",
      "Removed the \"Load testing data\" maintenance tool and its generated sample database."
    ]
  },
  {
    version: "0.17.1",
    label: "Track view polish & progress rings",
    changes: [
      "The track list on a book's page was reworked into a cleaner chapter/episode view: a play button on every row, tidied titles (the story name with the author as a byline for radio shows), and a circular progress ring — like the dial used for the context window in chat — that fills as you listen and shows a check when done. For episodic libraries the ring doubles as a played/unplayed toggle; for regular audiobooks it reflects your place, read-only.",
      "The same ring now appears on each chapter in the player, so the player and the book page share one visual language.",
      "Episodic fixes: \"Mark as finished\" and \"Reset\" now apply to every episode rather than just the last one, marking a track played fills its ring, and an episodic book's overall progress now reads \"X / N played\" instead of a misleading single-cursor percentage. A new \"Play next unplayed\" button jumps to the episode you're partway through, or the first one you haven't heard."
    ]
  },
  {
    version: "0.17.0",
    label: "Episodic libraries & smarter progress",
    changes: [
      "New \"Episodic\" progress mode for radio shows, podcasts, and other collections of standalone episodes: each track is tracked on its own — a played/unplayed toggle on every episode, a \"now playing\" marker, and a per-episode resume position — so skipping one episode never marks the others done. Turn it on per library in Edit → Scanning → Progress tracking.",
      "Fixed audiobooks being marked \"Finished\" just because you skipped or jumped ahead: a book now counts as finished only when you actually reach the end of its last track (or mark it finished yourself), so sampling the ending or skipping a chapter no longer completes the whole book."
    ]
  },
  {
    version: "0.16.0",
    label: "Members, library editing & scan status",
    changes: [
      "Editing a library is now a tabbed panel — Access, Upload, and Scanning — that matches the create wizard, replacing the old single long form.",
      "Manage members & roles was rebuilt: a public/private banner up top, an avatar for each user and group, and a role dropdown on every row that changes a member's role in place. The Everyone baseline appears as its own row, managed from the library's public-access setting.",
      "The Libraries page now shows a banner while any library is scanning, and each library's rescan button turns into a spinning, disabled indicator until its scan finishes.",
      "Create-library wizard polish: Quick setup always applies its recommended defaults (even after a detour through Custom), the last step shows a collapsible review of everything that will be created, finished steps can be clicked to jump back, and scan-source order can now be changed with up/down buttons that work by keyboard and touch — not just mouse dragging.",
      "Fixed a bug where rescanning a library emptied any series you had created by hand; books added to a series manually now stay put across rescans.",
      "Adding a library now rejects a folder that overlaps an existing library (the same folder, or one nested inside another) so the same files are not scanned twice."
    ]
  },
  {
    version: "0.15.0",
    label: "Create wizard: Upload & Scanning steps",
    changes: [
      "Creating a library in Custom mode gained dedicated Upload and Scanning steps — file extensions and the per-file upload limit, then the metadata sources and their priority order — and scan sources can be reordered by dragging."
    ]
  },
  {
    version: "0.14.0",
    label: "Standardized dialogs, buttons & messages",
    changes: [
      "Every dialog in the app now uses one shared modal component, so they all look and behave the same: Escape and clicking outside close them, and closing is blocked while a save or delete is running.",
      "Destructive actions got consistent confirmations — a question naming exactly what will be deleted, a note on what is not affected (your files on disk are never touched), and an explicit red Delete button instead of generic OK/Yes prompts.",
      "Buttons follow one vocabulary everywhere: Add attaches something existing, Create makes something new, Remove detaches without deleting data, and Delete destroys — always behind a confirmation.",
      "A new automated check (npm run check:ui) and a written UI convention guide keep future changes — human- or AI-written — on the same standard.",
      "Adding a library was redesigned around one wizard for every library type: Quick create needs only a type, name, and folder (recommended defaults cover the rest), while Custom setup walks through Basics, Access, and Scanning & upload steps.",
      "Tag text encoding is now a per-library setting: set it once (at creation or in Edit) and every scan repairs garbled legacy tags automatically — the Rescan dialog still allows a one-time override.",
      "Audiobook and ebook libraries are now managed on one Libraries page in the Control Panel, with a type column and All / Audiobooks / Ebooks filter — the old separate sections (and their duplicated code) are gone."
    ]
  },
  {
    version: "0.13.0",
    label: "Library scanning options & unified creation",
    changes: [
      "Adding an audiobook library is now a three-step wizard — Details, Scanning & upload, Source folder — and every scanning option you set there can be changed later from the Edit dialog.",
      "Metadata sources are now a prioritized list you control: \"Metadata files in folders\" (metadata.json), \"File metadata\" (embedded tags), and the new \"Folder structure\" can each be turned on or off and reordered — when two sources provide the same field, the higher one wins. The Rescan dialog is pre-filled with the library's saved sources and lets you override them for a single run.",
      "New \"Folder structure\" scan mode: each top-level folder under the library root becomes one book and every audio file beneath it becomes a track — ideal for collections organized by folder rather than by tags.",
      "Each library now has an editable file-extension list (pre-filled with sensible defaults per library type) that controls what gets scanned, and the same list will govern uploads; a per-upload size limit can also be set per library."
    ]
  },
  {
    version: "0.12.0",
    label: "Unified permissions & library modes",
    changes: [
      "Library access was rebuilt on one model: every user or group is granted a role on a library — Viewer (view), Member (view + download), Contributor (add/edit content), or Manager (full control) — plus an explicit Deny that blocks someone outright. Public access is just the built-in \"Everyone\" group's role.",
      "New library Mode: choose Managed (this app owns the files) or External / read-only — point the app at a folder managed by Plex or Audiobookshelf and use it purely as a viewer/streamer, with no risk of writing to it.",
      "Private libraries are now hidden even from admins until they explicitly Take ownership (a logged action) from the Control Panel, so a household member's private library stays private.",
      "Under the hood, one permission engine (can-user-do-this) now governs all library access, replacing several overlapping mechanisms — simpler and ready to extend to other content types."
    ]
  },
  {
    version: "0.11.0",
    label: "Library roles & permissions",
    changes: [
      "Libraries now support graduated roles you can grant to individual users or whole groups from Control Panel → Libraries / Ebooks → Members: Viewer (view only), Subscriber (view + download), Contributor (upload & edit items), Curator (manage series and structure), and Library Admin (full control including members and settings).",
      "Viewing and downloading are now separate permissions. Each public library has a \"Public access\" setting — View + download (the default) or View only — that sets what every signed-in person gets, and granting a user or group a lower role (for example Viewer) limits just them to in-app listening/reading with no file downloads.",
      "Sharing a book (guest links and user-to-user shares) now requires the Curator role, and a book's Edit, Download, and Share buttons appear only when your role on that library allows them."
    ]
  },
  {
    version: "0.10.1",
    label: "Audiobook library polish",
    changes: [
      "Audiobook tiles now use a larger cover-first layout with an expanded hover panel for play, favorite, download, collection, share, and admin actions.",
      "Book details have icon-first action controls, refreshed tag pills, and progress actions grouped directly inside the listening progress card.",
      "Library and sort dropdowns on the audiobook page stack options vertically again after the tile menu redesign."
    ]
  },
  {
    version: "0.10.0",
    label: "PWA navigation & offline reliability",
    changes: [
      "Phone and installed-PWA navigation now uses a native-style bottom tab bar: Home, Media, Downloads, Collections, and Profile.",
      "Media remembers whether you last used Audiobooks or Ebooks, while personal library pages keep a compact icon-only navigation strip on phones.",
      "Offline downloads now keep enough book metadata in IndexedDB to open downloaded details and the player even after API cache entries expire.",
      "Private runtime caches are cleared on setup reset, logout, lost auth, and account switches; public app artwork is cached separately for offline launches."
    ]
  },
  {
    version: "0.9.1",
    label: "Bookmarks & quick navigation",
    changes: [
      "New Bookmarks page — every spot you've saved while listening, gathered in one place under the user menu.",
      "A navigation toolbar now sits on the personal pages (Favorites, Bookmarks, Collections, Shared with me, Theme, Profile), so you can jump between them without opening the menu each time.",
      "Audiobook tiles: the ⋮ menu now includes \"Add to collection,\" and \"Edit metadata\" opens the full editor (the same one as the book page) instead of the bulk-overwrite dialog.",
      "Polished the remove control on the Favorites and Bookmarks tiles."
    ]
  },
  {
    version: "0.9.0",
    label: "Collections & themes",
    changes: [
      "New Collections — build your own ordered lists (\"playlists\") of audiobooks. Add a book from its menu, reorder or remove items, and rename or delete a collection from its page. Collections live under the user menu.",
      "Continuous playback — \"Play all\" walks a collection book-by-book, showing the playlist position and an \"Up next\" card, and automatically rolls into the next book when one finishes.",
      "Collections are built on a shared, media-agnostic foundation, so future library types (ebooks, photos, video) and Notes can reuse them without rework.",
      "Theme picker — choose your own light/dark/system look from a dedicated Theme page, and admins can set the default theme for new sign-ins from Control Panel → Config."
    ]
  },
  {
    version: "0.8.12",
    label: "Polished install card",
    changes: [
      "The \"Install the mobile app\" card on the sign-in and profile pages now shows platform-specific guidance with iPhone and Android options and recognizable icons — a one-tap Install on Android/Chrome, or step-by-step \"Add to Home Screen\" instructions on iOS."
    ]
  },
  {
    version: "0.8.11",
    label: "Clearer install prompt",
    changes: [
      "The sign-in and profile pages now always show how to install the mobile app when you're in a browser — a one-tap Install button where the browser supports it, or step-by-step \"Add to Home Screen\" guidance otherwise."
    ]
  },
  {
    version: "0.8.10",
    label: "Cleaner install & offline",
    changes: [
      "Added an Install button on the sign-in and profile pages — one-tap on Android/desktop, with Add-to-Home-Screen steps on iOS.",
      "Save offline and the Downloads screen now appear only in the installed app, where offline storage is reliable; in a browser tab you'll see a prompt to install instead.",
      "Removed the pop-up install banner in favor of the explicit buttons."
    ]
  },
  {
    version: "0.8.9",
    label: "Docs & release notes",
    changes: [
      "Expanded the README with Docker deployment, the HTTPS requirement for the installable app, a Caddy reverse-proxy example, and phone install steps for Android and iOS.",
      "Backfilled this What's New timeline with the 0.8 series — the progressive web app (PWA) and offline work below."
    ]
  },
  {
    version: "0.8.8",
    label: "Mobile layout fixes",
    changes: [
      "The Audiobooks page now fits phone screens — no more sideways scrolling — with a denser, right-sized cover grid."
    ]
  },
  {
    version: "0.8.7",
    label: "Reliable offline launch",
    changes: [
      "Opening the installed app with no connection no longer hangs or gets stuck on a sign-in screen: it opens straight into your library from your last sign-in, and only asks you to sign in again when the server is actually reachable."
    ]
  },
  {
    version: "0.8.6",
    label: "Sign-in QR & show password",
    changes: [
      "The sign-in page shows a QR code of the current address, so you can open the app on another device by scanning it.",
      "Password fields now have a show/hide toggle."
    ]
  },
  {
    version: "0.8.5",
    label: "Lock-screen & car controls",
    changes: [
      "The player reports now-playing info (cover, chapter, author) to your device and wires up the lock-screen, car, and Bluetooth controls — play, pause, skip chapters, and scrubbing."
    ]
  },
  {
    version: "0.8.3",
    label: "Manage downloads",
    changes: [
      "New Downloads screen (account menu → Downloads): see every book saved for offline, a device storage meter, and remove downloads to free space."
    ]
  },
  {
    version: "0.8.2",
    label: "Offline progress sync",
    changes: [
      "Listening positions saved while offline now sync to the server automatically when you reconnect, and resume works offline."
    ]
  },
  {
    version: "0.8.1",
    label: "Offline listening",
    changes: [
      "Save a book for offline from its detail page (Save offline); the player then plays it from on-device storage with no connection, including seeking.",
      "On iPhone, a tip prompts you to add the app to the Home Screen first so downloads aren't cleared by Safari."
    ]
  },
  {
    version: "0.8.0",
    label: "Install to your phone",
    changes: [
      "isputnik.home is now an installable app (PWA): add it to your home screen and it launches full-screen and opens even offline. Requires serving the app over HTTPS."
    ]
  },
  {
    version: "0.7.1",
    label: "Player polish & smarter bulk edit",
    changes: [
      "The audiobook player was reworked: a compact bottom-anchored layout, a book-progress pill, an accent play button, an accent progress bar, and bordered action buttons — and it now sizes nicely on phones.",
      "Bulk edit and the per-book Edit form now share the same Author, Narrator, and Tag pickers — type to choose existing values or add new ones, instead of typing comma-separated text.",
      "Audiobook book tiles on the main page now sit on a transparent card (cover-forward), matching the home dashboard look."
    ]
  },
  {
    version: "0.7.0",
    label: "Redesigned audiobook tiles & bulk editing",
    changes: [
      "Audiobook tiles were redesigned: a cleaner cover (no redundant headphones badge), a listening-progress bar, a finished tick, listening duration and series position, and a denser grid that stays two-up on phones.",
      "Each tile now has quick actions — a favorite heart and a hover Play button — plus a ⋮ menu for Play, Mark finished/unfinished, Download, Share, and (for editors) Edit metadata. These never interfere with opening the book.",
      "New multi-select mode (the Select button): pick books across libraries and overwrite shared metadata — Author, Narrator, Category, Language, Tags, or Description — in one action. Editors can also edit a single book inline from its ⋮ menu.",
      "The Special Libraries feature was removed to keep things simple; section/override data is cleaned up automatically. Existing libraries and books are unaffected."
    ]
  },
  {
    version: "0.6.1",
    label: "Shared navigation & library UI polish",
    changes: [
      "Primary pages now use one shared left navigation with a profile dropdown and bottom-aligned Settings and About links; the control panel also includes a Home link.",
      "Audiobook browsing has a reorganized catalog header, and the home dashboard uses compact book-cover cards that match the audiobook catalog scale.",
      "Book details now expose additional metadata through an expandable More details panel, while Edit Metadata has a larger responsive layout with dedicated Metadata, Series, Cover, and Metadata Lookup tabs.",
      "Admins can create tags manually from Control Panel > Labels > Tags, alongside rename, delete, merge, and remove-unused actions.",
      "Control-panel actions and light-theme primary buttons were made more consistent, with disabled controls using the standard unavailable cursor."
    ]
  },
  {
    version: "0.6.0",
    label: "Audiobook search & paging",
    changes: [
      "The audiobook catalog now searches, filters, sorts, and pages on the server, loading a page at a time (infinite scroll plus a Load more button) instead of fetching every book up front — so large libraries stay fast.",
      "Search matches titles, authors, narrators, and series; filters (authors, narrators, categories, tags, series, language, status, length) and sorting now run against the whole library, not just what's loaded.",
      "The special-library (section) view uses the same paged catalog."
    ]
  },
  {
    version: "0.5.3",
    label: "Internal code cleanup",
    changes: [
      "Maintenance release: split two oversized source files (the audiobook page and the audiobook server routes) into focused modules. No user-facing changes."
    ]
  },
  {
    version: "0.5.2",
    label: "Audiobook browse redesign & testing tools",
    changes: [
      "Audiobook browsing was rebuilt into one full-width, tabbed layout (Books, Authors, Narrators, Series, Collections) with a shared header, replacing the old per-page sidebar navigation.",
      "The special-library (section) view now matches the main library: same header and filter/sort/view controls, with a \"back to all libraries\" link instead of a separate sidebar.",
      "Filter, Sort, and the grid/list toggle now sit together on one row next to the library picker, which is now a dropdown menu styled like the book actions menu.",
      "Author, Narrator, and Series pages use the same back button as book detail and drop the redundant per-page search and profile chrome.",
      "Invite links hardened: only the token hash is stored (the link is shown once when created), and links now use the address you're actually visiting instead of a fixed default.",
      "New admin tool (Control Panel → Maintenance → Backup): \"Load testing data\" loads a generated fake-audiobook database for interface testing, taking a full backup of your current library first."
    ]
  },
  {
    version: "0.5.1",
    label: "Ebook browse page",
    changes: [
      "Dedicated ebook browse page and an ebook-aware book detail view."
    ]
  },
  {
    version: "0.5.0",
    label: "Ebooks (EPUB/PDF)",
    changes: [
      "New ebook library type with an in-app EPUB and PDF reader."
    ]
  },
  {
    version: "0.4.17",
    label: "Backups",
    changes: [
      "New Backup screen (Control Panel → Maintenance → Backup): create an on-demand backup, download, restore, or delete — admin only.",
      "Backups are a zip of the database plus cover art (uploaded and provider-fetched covers can't be regenerated); the database snapshot is taken live with no downtime. Media files and the metadata cache are not included.",
      "Scheduled daily backups with a configurable time, retention limit, and an include-covers toggle.",
      "Restore puts cover art back immediately and stages the database to be applied on the next server restart, after auto-saving the current database first.",
      "Configurable via BACKUP_PATH and BACKUP_RETENTION."
    ]
  },
  {
    version: "0.4.16",
    label: "Listening progress & UX polish",
    changes: [
      "Book cards now show a listened indicator — a checkmark when finished and a progress bar while in progress.",
      "Book detail lists each file's state under Files: completed, playing, or not started (derived from your current position).",
      "Tags moved under the cover on the book page and are now clickable — open a tag to see every book carrying it.",
      "Adding a library is now a step-by-step wizard (Details → Metadata overrides → Source folder) so the form fits the window.",
      "Special-section overrides (Author, Narrator, Tags, etc.) are now correctly optional — leave any blank to keep scanned values.",
      "Wider Edit library dialog and clearer spacing in the section dialog."
    ]
  },
  {
    version: "0.4.15",
    label: "Special sections & control panel",
    changes: [
      "New Labels screen (Categories + Tags tabs). Tag management: rename tags (renaming onto an existing tag merges them), delete a tag from all books, and remove unused tags in one click.",
      "Audiobook catalog stats (libraries, top authors/narrators, longest listens) moved from the Status page to a dedicated Stats tab under Control Panel → Audiobooks; Status now focuses on system and database health.",
      "Audiobook libraries can now be grouped into a Special Section — a master entry in the audiobook sidebar (with its own icon) that holds one or more libraries. Section books are kept out of the main Books grid and browsed behind the section.",
      "Each library added to a section has its own Overwrite-on-add rules: force Author, Narrator, Description, Category, and Tags for every book on add and rescan. Blank fields keep the scanned value (e.g. a blank Author keeps each story's real writer).",
      "Manually edited books still win — overrides apply as scan metadata, so a per-book manual edit survives rescans.",
      "Admins manage sections from Control Panel → Audiobooks: create/edit/delete sections and attach libraries with their override values. Deleting a section detaches its libraries (no books or files are removed).",
      "Control Panel navigation reorganized: a new Digital Library group (Storage, Audiobooks, plus Gallery / Other Media placeholders for future types), a Maintenance screen for Jobs (with a Backup placeholder), and database details folded into the Status page. User administration is now a single Accounts screen with Users / Groups / Invite links / Sessions tabs. The Audiobooks screen splits into Audiobooks, Special libraries, and Stats tabs."
    ]
  },
  {
    version: "0.4.13",
    label: "Category management polish",
    changes: [
      "Category management is now centered on the category list, with mappings managed inside each category editor instead of a separate global tab.",
      "The category editor now has Mappings and Tags tabs. Tags shows scanned genre tags with book counts and lets an admin add a tag as a keyword for the current category.",
      "Added an on-page explanation of category mapping, including a concrete priority example, so admins can understand why a book lands in a category.",
      "New installs now include default category images for the public audiobook category cards, while category management remains icon-first unless an admin uploads a custom image.",
      "Default category mappings for new installs are now English-only. Existing databases keep their current mappings until an admin changes them."
    ]
  },
  {
    version: "0.4.12",
    label: "Categories & tags",
    changes: [
      "Books are now sorted into a fixed set of navigation Categories (Fiction, Classics & Literary, Adventure & Action, Mystery & Thriller, Sci-Fi & Fantasy, Horror & Supernatural, Romance, Humor & Satire, Biographies & Memoirs, History, Self-Help & Business, Science & Culture, Kids & Teens) with a General / Other fallback — replacing the old free-form Genres.",
      "Every original genre is kept as a searchable Tag, shown as chips on the book page; nothing is discarded. Tags are global and ready to be reused by future library types.",
      "During a scan, incoming genre text is matched to a category via keyword mappings; unmatched books fall back to General / Other.",
      "Book editor now has a Category dropdown and a Tags field; a manual choice is preserved across rescans.",
      "New admin Control Panel section for categories: rename/reorder categories, manage keyword-to-category mappings, and Re-match all books from their existing tags instantly — no file rescan needed.",
      "Each category has an icon (admin-pickable) plus an optional uploaded image that overrides it, shown on the category browse cards."
    ]
  },
  {
    version: "0.4.11",
    label: "Status dashboard & book rescan",
    changes: [
      "Status page now has separate System and Libraries & Books sections with prettier metric cards.",
      "Library status now shows total libraries, total books, total audiobook size, total listening hours, and per-library books, size, and hours.",
      "Added Top 10 Authors, Top 10 Narrators, and Top 10 Books by Hour to the status page.",
      "Added a single-book rescan API that supports skip-sidecar and tag-encoding repair options while preserving library write-access checks.",
      "Encoding repair now also fixes mojibake inside metadata.json sidecars, not only audio tags, so rescans can repair titles, descriptions, people, series, genres, and publisher fields."
    ]
  },
  {
    version: "0.4.10",
    label: "Audiobook detail polish",
    changes: [
      "My List now supports removing saved books directly from the My List page.",
      "Book detail pages now keep actions, description, and the files dropdown aligned in the book info column.",
      "Book metadata and descriptions are more compact by default, with show-more controls for the full detail set.",
      "Removed the reset-progress button from book details and the extra top brand icon from the popup player."
    ]
  },
  {
    version: "0.4.9",
    label: "Bookmarks, My List & encoding fix",
    changes: [
      "Bookmarks: save a spot in any audiobook with an optional note, then view, edit, delete, or jump back to it from the player. Bookmarks are now stored on the server (synced across devices) — any older browser-only bookmarks are migrated automatically.",
      "My List: save whole audiobooks to a personal list with an optional note, browsable from the new 'My List' tab in the audiobook sidebar.",
      "Rescan options: the Rescan button now opens a dialog to skip metadata.json sidecars and to fix garbled tag text (mojibake). Choose Windows-1251/1250/1252 or KOI8-R to repair tags like 'Ðàíåå' → 'Ранее'; correctly stored and manually edited metadata is left untouched.",
      "Player redesign: refreshed popup with Speed, My List, Bookmarks, Add Note, and Mark as Finished in one row and a full-width Chapters bar below, plus a volume slider, two-line chapter heading, brand header, and quick Download / Reset progress.",
    ]
  },
  {
    version: "0.4.8",
    label: "Security hardening",
    changes: [
      "Cover-art downloads can no longer reach internal or private network addresses (SSRF protection), follow redirects, or exceed their size cap — the limit is now enforced while streaming rather than trusting the response headers.",
      "Hardened a library access lookup against SQL injection and applied the same path-traversal safety check to book downloads that the streaming endpoint already used.",
    ]
  },
  {
    version: "0.4.7",
    label: "Popup player & sidecar improvements",
    changes: [
      "Audiobook player now opens in a dedicated popup window (Audible-style) at /player/:id — stays alive while browsing the main app.",
      "Player popup features large cover art, chapter title, Audible-style minimal controls (outlined skip circles, large dark play button), and a bottom-sheet chapter list that slides up full-screen.",
      "Add a Bookmark button saves the current position to localStorage for later reference.",
      "Mark as Finished available via the ⋯ menu in the player popup.",
      "Thumbnails are now organized by library ID on disk — deleting a library cleans up its covers with a single folder removal. Author photos live under a shared 'people/' bucket.",
      "Sidecar metadata: series strings in 'Name #N' format are now parsed into separate series name and position fields (e.g. 'Читер #2' → series: Читер, position: 2).",
    ]
  },
  {
    version: "0.4.6",
    label: "Scan performance & reliability",
    changes: [
      "Scan is now 5–10× faster: audio files within each book are parsed in parallel, SHA-256 hashing removed (size + mtime fingerprint is sufficient), and up to 4 books are processed concurrently.",
      "Async directory walk no longer blocks the HTTP server during large library scans.",
      "Each book is written to the database as soon as it finishes — partial progress is preserved if the scan is cancelled or the server restarts.",
      "Jobs page now shows live scan progress (X / Y books) while a scan is running.",
      "Fixed: cancelling a job now immediately sets the library status to error; the cancelled scan no longer gets rescheduled for retry.",
      "Fixed: certain M4B files caused music-metadata to hang indefinitely due to a chapter-parsing bug. Chapter parsing removed (unused); 15-second parse timeout added as a safety net.",
      "Fixed: folder cover images are now found even when the filename is not a standard name like cover.jpg — the scanner falls back to the largest image file in the folder.",
      "Fixed: cover images in the Edit Metadata cover browser showed as broken links due to a Fastify async streaming issue. Fixed by reading image files into a buffer before sending.",
      "New library setting: Do not read metadata.json — when enabled at library creation time, sidecar metadata files are ignored during all scans.",
      "Book detail page now shows the folder path of the book on disk.",
    ]
  },
  {
    version: "0.4.5",
    label: "Unraid scanner hardening",
    changes: [
      "Fixed audiobook scans failing on Unraid when sidecar metadata provided series values as objects instead of plain strings.",
      "Sidecar metadata normalization now safely supports object-style series names and sequence numbers before writing to SQLite.",
    ]
  },
  {
    version: "0.4.4",
    label: "Linux scan fixes",
    changes: [
      "Fixed crash on Linux/Unraid: replaced ON CONFLICT(cols) DO NOTHING with INSERT OR IGNORE throughout — certain SQLite builds on Linux miscounted binding parameters in the ON CONFLICT clause.",
    ]
  },
  {
    version: "0.4.3",
    label: "Scan reliability & job controls",
    changes: [
      "Fixed scanner crash on Linux (Unraid) caused by audio tag fields returning non-string values — now handled safely throughout.",
      "Scanner no longer aborts on a single bad book — each book is processed independently, errors are collected and reported.",
      "Job cancellation: active jobs can now be cancelled from the Jobs page.",
      "Jobs page now shows scan results (books and files discovered, skipped count) and full error details on click.",
      "Running jobs that exceed 10 minutes show a pulsing warning badge.",
      "Job errors now include the full stack trace for easier diagnosis.",
    ]
  },
  {
    version: "0.4.2",
    label: "Jobs, Database & library management",
    changes: [
      "Added Jobs page in the control panel showing the last 50 background jobs with status, duration, and error details. Auto-refreshes while jobs are active.",
      "Added Database page showing the SQLite file path, size, WAL size, and last modified time for backup reference.",
      "Added Delete library button with a confirmation modal — removes all database records without touching files on disk.",
      "Rescan button is now disabled and shows 'Scanning…' while a library scan is already in progress.",
    ]
  },
  {
    version: "0.4.1",
    label: "Logo update",
    changes: [
      "Updated application logo and brand assets.",
    ]
  },
  {
    version: "0.4.0",
    label: "Series, Genres & Groups",
    changes: [
      "Added Series list and detail pages — browse, create, rename, delete series, and manage which books belong to each.",
      "Added Genres list and detail pages — browse, create, rename, delete genres, and manually assign books to genres.",
      "Added user groups — admins can create groups, add members with member or manager roles, and assign libraries to groups.",
      "Library sharing: libraries can now be owned by a group, giving all group members access.",
      "Library access control extracted into shared module — consistent read/write permission checks across all library endpoints.",
      "Audiobook list page now supports filtering by library, author, and narrator.",
    ]
  },
  {
    version: "0.3.0",
    label: "Library navigation & people",
    changes: [
      "Redesigned navigation: section links moved to the top bar, left sidebar is now contextual per section.",
      "Added Authors and Narrators pages under Audiobooks with name search and book counts.",
      "Added person detail page showing all books by that author or narrator.",
      "Added person profile editing: name, sort name, biography, and photo upload.",
      "Added library, author, and narrator filter dropdowns to the audiobooks page.",
      "App logo now links home; Home button removed from navigation.",
      "Top navigation bar now shown on all pages including the control panel.",
      "Removed About from the control panel sidebar — accessible from the top menu.",
      "Docker template now supports one required media path plus two optional additional paths.",
    ]
  },
  {
    version: "0.2.3",
    label: "Docker & self-hosting",
    changes: [
      "Added Docker support with multi-stage build and GitHub Container Registry publishing.",
      "Added Unraid Docker template with /config volume convention for appdata.",
      "Fixed session cookies not persisting over plain HTTP on local networks.",
      "Fixed invite links using server URL from the request instead of configuration.",
    ]
  },
  {
    version: "0.2.0",
    label: "Audiobook player UX",
    changes: [
      "Added skip ±30 s buttons with automatic cross-chapter wrap-around.",
      "Added overall book progress bar showing position across all chapters.",
      "Added toggleable chapter list panel with click-to-jump navigation.",
      "Progress is now saved on browser/tab close via fetch keepalive.",
      "Added audiobook library with folder scanning, metadata editing, and cover art.",
      "Added metadata lookup via iTunes, OpenLibrary, and FantLab providers.",
      "Added byte-range streaming endpoint with seek support."
    ]
  },
  {
    version: "0.1.0",
    label: "Initial release",
    changes: [
      "Added the application shell with protected routes, profile settings, and light, dark, and system themes.",
      "Added invite-only account creation with copyable invitation links, link status, and revocation.",
      "Added the control panel with status, logs, user roles, active session management, and About.",
      "Grouped control-panel navigation and made About available in the main application.",
      "Added compact log search, paging, and manual retention cleanup with a 365-day default."
    ]
  }
];
