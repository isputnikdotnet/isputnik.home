# Quote packs

Ready-to-import packs for **Control panel → Utilities → Widgets → Quotes**. See
[the user guide](../../docs/users/quotes.md) for the format and what importing
does.

| File | Quotes | |
|---|---|---|
| `quotes-top100-en.json` | 100 | Twain, Wilde, Shakespeare, Dickens, Austen, Emerson, Thoreau, Franklin, Marcus Aurelius, Confucius, da Vinci, Aristotle, Plato, Seneca, Nietzsche, Hugo, Tolstoy |
| `quotes-top100-ru.json` | 100 | Чехов, Толстой, Достоевский, Пушкин, Гоголь, Тургенев, Прутков, Лермонтов, Грибоедов, Салтыков-Щедрин, Крылов, Горький, Куприн, Даль |

Both arrive family-visible and in the daily rotation, so importing one starts
feeding the quote of the day immediately. Import both and each reader gets the
card in their own language, since the pick prefers the language the app is being
read in.

## Where they came from

Built from Wikiquote with [`../quotes-from-wikiquote.mjs`](../quotes-from-wikiquote.mjs):

```bash
node scripts/quotes-from-wikiquote.mjs --lang en --out quotes-top100-en.json \
  --limit 8 --total 100 --tags Wisdom \
  --pages "Mark Twain" "Oscar Wilde" "William Shakespeare" …
```

`--limit` caps each author and `--total` caps the pack, interleaving authors so
a hundred quotes are a spread rather than the first three pages. Wikiquote lists
the best-known quotes near the top of a page, so taking one from each in turn
takes the famous ones first.

Every author here died more than seventy years ago, so the quotes themselves are
public domain. Wikiquote's own compilation is CC BY-SA — no concern for a
private family library, worth attributing if you ever republish.

## Read them before you trust them

The converter skips the "Misattributed" and "Disputed" sections that every quote
collection on the internet otherwise inherits, and drops rows carrying markup or
citation debris. It does not, and cannot, verify that a quote is real.

So: import, read the dry-run preview, and skim the result. Each import can be
deleted as a whole from the same page, which is what makes trying one cheap.
