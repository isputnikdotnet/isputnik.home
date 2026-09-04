# Scan rules

A scan rule teaches the scanner one folder's own way of being organised.

Most of an ebook library needs nothing: point it at a folder, and the scan works
out what is a book. But almost every collection has a corner that is filed its
own way — an author's shelf laid out `Author / Series / 01. Title`, a set of
scanned volumes where the series name is a folder and the number is in front of
the title. Left to the default scan those come out as bare folder names with no
author and no series. A rule says "in *this* folder, the shape is *this*", and
only there.

Rules are for **ebook libraries**. Audiobooks and the gallery don't offer them.

## Making one

**Control panel → Libraries → the ebook library → Scan rules → Add rule.**

The editor has two tabs.

**Name & folders.** Give the rule a name you'll recognise later — the author or
the collection it covers is usually the right name. Then **Browse folders**
opens a picker rooted at the library itself: open a folder to go deeper, and
**Add this folder** claims it for the rule. You can add several, and **Add
library root** covers the whole library where the whole library is the exception.
Chosen folders appear as a grid, each removable with one click.

**Rule.** This is the layout. Start from a **preset** if one fits:

| Preset | Pattern |
| --- | --- |
| Series / Book | `{series}/{position}. {title}` |
| Author / Series / Book | `{author}/{series}/{position}. {title}` |
| Author / Book | `{author}/{title}` |

Otherwise write the pattern yourself. Folders are separated by `/`, and anything
that isn't a token is matched literally, so `{position}. {title}` expects the
number, a dot, a space, then the title.

The tokens:

| Token | What it takes |
| --- | --- |
| `{author}` | the author's name |
| `{series}` | the series name |
| `{position}` | the number in the series |
| `{title}` | the book's title |
| `{ignore}` | a folder level to skip — it maps to nothing |

Two tokens can't sit side by side (`{author}{title}` has no way to know where one
ends), and each token is used once. Everything else is yours to arrange.

## Preview before you save

**Preview** dry-runs the pattern over the real files in the folders you chose and
shows a table: the path as it is on disk, and the author, series and title the
rule would read out of it. Nothing is written — it is there so you can see the
rule work, or see it miss, before it becomes how those books are catalogued.

"No files matched in those folders" means the pattern's shape doesn't fit: most
often it has more or fewer `/` levels than the folders actually have. The depth
has to match exactly, counted from the folder the rule is anchored on.

## Nesting, and which rule wins

Rules may overlap. When more than one rule's folder contains a book, **the most
specific one wins** — the longest matching path, so a rule on
`Sanderson/Cosmere` beats a rule on `Sanderson` for everything inside it. Two
rules can't claim the exact same folder; the editor says so if you try.

That is also the answer to a folder with an extra level in it. If a "universe"
folder holds several sub-series, add a second rule on that deeper folder and use
`{ignore}` for the wrapping level.

A rule you turn **off** keeps its folders and its pattern, and the default scan
takes those folders back until you turn it on again. Turning off a specific rule
hands its folders to the *default* scan, not to a broader rule that also covers
them.

## Names that are almost right

Real files are inconsistent, and the matching allows for it:

- `1. Title` and `1.Title` — with or without the space — both match
  `{position}. {title}`.
- Extra spaces don't matter: `1.  Title` matches too.
- Genuine decimals survive. `2.5. Half a Life` reads position `2.5`, not `2`,
  because the dot inside the number is followed by a digit.

## When it takes effect

**On the next rescan.** Saving a rule doesn't re-read anything by itself — run
**Rescan** on that library (Control panel → the library) when you want the books
re-read under the new rule.
