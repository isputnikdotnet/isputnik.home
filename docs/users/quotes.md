# Quotes

A quote is any piece of writing worth keeping: a passage you highlighted while
reading, a line from someone famous, or something your four-year-old said at
breakfast that the family still repeats.

They all live in one place — **Quotes**, in your library menu — and turn up
wherever they're relevant: on the home page as the quote of the day, and on a
relative's page in the family tree.

## Where quotes come from

**While reading.** Select a passage in the ebook reader and save it. The
highlight stays on the page, and the quote remembers where it came from, so you
can jump straight back to that spot later.

**By hand.** **Add quote** on the Quotes page takes anything you like to type —
a line you heard, something from a book that isn't in your library, a family
saying.

**From a file.** An administrator can bring in hundreds of quotes at once from a
JSON file. See [Importing a pack](#importing-a-pack) below.

## Adding a quote

Only the quote itself is required. Everything else is there when it helps:

- **Book / source** and **Author** — where it came from. A quote saved while
  reading fills these in from the book and doesn't ask.
- **Who said it** — a person from your [family tree](family-tree.md). This is
  deliberately separate from the author: the author *wrote* the book, this
  person *said* the words. It's what puts a quote on that relative's page.
- **Categories** — free labels like `Funny`, `Kids` or `Wisdom`. See
  [Categories](#categories).
- **Note** — why it stuck with you. Yours alone, even on a shared quote.
- **Language** — which language the quote is in, so the quote of the day can
  prefer the one you read the app in.
- **Date said** and **Context** — when and where. A year (`2019`), a month
  (`2019-08`) or a full date (`2019-08-27`), the same forgiving format the
  family tree uses for birthdays. A full date is what lets a quote come back on
  its anniversary.
- **Visibility** and **Include in Quote of the day** — see the next two sections.

## Who can see a quote

Every quote is one of two things:

- **Private — only me.** The default. Nobody else sees it anywhere, including
  every passage you highlight while reading.
- **Family — everyone signed in.** Shared with the house. It appears on the
  Quotes page for everyone, and can turn up as the quote of the day.

On the Quotes page you see your own quotes plus everything the family shares.
Someone else's quote is read-only — you can copy it or collect it, but the edit
and delete buttons belong to whoever saved it, and the card says who that is.
Use the **Just mine** filter to narrow the page back down to yours.

> **Highlights stay private unless you say otherwise.** Saving a passage while
> reading never shares it. If you want one on the family's shelf, edit it and
> change its visibility.

## Categories

Categories are just labels, and you make them up as you go: `Funny`, `Kids`,
`Wisdom`, `Toasts`, `Grandma`. A quote can wear several.

They're offered back to you wherever they're useful — the editor suggests ones
already in use, so the family converges on a handful rather than fifty
near-duplicates; the Quotes page shows the most-used as filters; and the quote
of the day lets each person choose a category to draw from.

Only categories that quotes actually wear are ever shown, so the list stays as
short as your collection is.

## Quote of the day

If any shared quote is in the rotation, the home page carries one — the same
quote for everyone in the house, all day, replaced the next morning.

**It's opt-in.** A quote joins the rotation only when **Include in Quote of the
day** is ticked. Imported packs opt in by default (that's the point of them);
your reading highlights and hand-typed quotes stay out until you say so.

**In your language.** If the pool has quotes in the language you're reading the
app in, the card prefers those. If it doesn't, you still get a quote rather than
an empty card.

**Your own category.** The card carries the categories in use, and whichever you
pick is remembered on that device. Everyone in the family can choose differently
— one person reads only `Funny`, another takes whatever comes. Choosing **All**
puts you back on the whole pool.

**Anniversaries.** If something was said on this day in an earlier year, that
quote takes the card and says so — *"7 years ago today"* — instead of the usual
pick. This is what the **Date said** field is for, and it needs a full date: a
quote dated only to a year has no day to come round again. It still has to be in
the rotation, and picking a specific category takes precedence, so the switcher
always does what you asked.

## Family sayings

Attach a quote to someone in the family tree with **Who said it**, and it shows
up on that person's page under a **Quotes** tab, with the date and the
circumstances you recorded.

The link survives the tree changing. Rename a relative and their quotes follow
the new name; remove them from the tree altogether and their sayings stay put,
still attributed, rather than going anonymous.

Together with a full **Date said**, this is what makes the anniversary card
work: *"5 years ago today — Mum, my tummy says it's cake o'clock." — Leo, age 4.*

## Collections

Quotes go into [collections](your-account.md) like books and photos do, so you
can gather "Things the kids said" or "Toasts for the next birthday". Use the
list button on a quote card. Opening a quote from a collection takes you to the
Quotes page with that one highlighted.

## Finding and tidying up

The filters above the list cut it down by who saved a quote, where it came from
(reading, typed by hand, imported), whether it's in the daily rotation, and by
category. That matters most after an import: a pack off the internet always has
a few duds, and this is how you find and delete them.

Quotes are grouped by their source, so everything from one book sits together
and each author's lines gather under their name.

## Importing a pack

**Administrators only**, and it lives in the control panel: **Utilities ›
Widgets › Quotes**. A pack decides what the whole house reads, so bringing one in
is an administrative act in the same way adding a library is — and that page is
where a pack is taken back out again. Everyone can still add their own quotes one
at a time from the Quotes page.

**Import a pack** takes a JSON file shaped like this:

```json
{
  "version": 1,
  "defaults": { "language": "en", "visibility": "family", "inRotation": true },
  "quotes": [
    {
      "text": "The secret of getting ahead is getting started.",
      "author": "Mark Twain",
      "source": "",
      "language": "en",
      "date": "1897",
      "context": "",
      "tags": ["Wisdom"]
    }
  ]
}
```

Only `text` is required in each quote. `defaults` describe the pack as a whole
and can be left out entirely — a pack is shared with the family and put in the
daily rotation unless it says otherwise. A quote may override the language for
its own line.

**Nothing is saved until you confirm.** Choosing a file only *checks* it, and
the counts you see are the real answer for that exact file: how many are new,
how many you already have, and how many rows couldn't be read. The button then
imports precisely what was previewed.

**Importing the same pack twice is harmless.** Quotes already saved are skipped,
matched on the words and the author, ignoring capitals and spacing. Duplicates
inside a single file are skipped too.

**One bad row doesn't sink the file.** Rows that can't be read are listed by
line number with the reason, and everything else still comes in.

A single file can hold up to 5,000 quotes. A bigger one is refused rather than
half-imported — split it and run it twice.

### Undoing an import

Every import is kept as the event it was — the file name, when it came in, and
how many of its quotes are still here. Each one has its own **Delete**, which
removes everything that pack brought in and nothing else: quotes typed in by
hand, passages highlighted while reading, and other people's quotes are all left
alone, and the file can always be imported again.

That is the safety net for a pack off the internet. Import it, look at what it
did to the quote of the day, and if you do not like it, one button takes it back
out.

> **Where to find packs.** Public-domain quote collections are easy to come by
> online as JSON, in many languages. They rarely match the format above exactly,
> so expect to rename a few fields before importing.

---

Quotes are part of the app's database, not a folder that can be re-scanned. Like
the family tree, they exist only in that database — so keep taking
[backups](control-panel.md).
