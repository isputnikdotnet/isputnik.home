# Your account

Everything that belongs to you rather than to the server: your name and sign-in
details, how the app looks, where your saved things live, and the address your
e-reader receives books at.

All of it hangs off the **menu with your name on it** (bottom-left on a computer,
the **Profile** tab in the installed app). That menu has two halves: **Profile**,
which is your account settings, and the list of things you've saved.

## Profile — your account settings

**Profile** opens a page with five tabs. Each has its own address, so you can
bookmark the one you use and the back button returns you to it rather than
leaving the page.

### Account

| | |
|---|---|
| **Display name** | What other people in your household see beside anything you share |
| **Sign-in email** | The address you log in with |

Changing the email needs your current password, and both addresses are told about
it afterwards — the old one included, because if the change wasn't you, the old
inbox is the only place that news can still reach you.

### Security

- **Change password** — needs the current one.
- **Two-factor authentication** — a one-time code after your password, from an
  authenticator app or by email. This is the single biggest thing you can do for
  your account; it has [its own guide](two-factor-authentication.md).

Turning two-factor on or off, changing your password, and changing your email all
send you a note. If one arrives that you didn't cause, change your password.

### Shared links

Every guest link you have made, in one list — for a book, a photo, an album, or a
selection of photos. Each row shows what it points at, when you shared it, and
when it expires; expired ones are listed separately and greyed, because knowing a
link *stopped* working is often the thing you came to check.

**Revoke** cuts a link off immediately. Nothing is deleted, and anyone you shared
with by account keeps their access — that is a different kind of sharing, managed
per item on the **People** tab of the Share box.

The link addresses themselves are not here, and cannot be. Only a fingerprint of
each link is stored, never the link itself, so it can be shown to you exactly
once — when you create it. If you have lost a link, revoke it and make a new one.
The upside is that someone who steals a copy of the database still cannot open
anything you have shared.

Only your own links appear, and this is the only place to see them all; an
administrator cannot list yours from here either.

### Appearance

Six choices, saved to your account, applied the moment you pick one — so the same
theme follows you to your phone.

| | |
|---|---|
| **System** | Follows your device's light/dark setting |
| **Expanse** | Deep blue-black with a cyan accent |
| **iSputnik Night** | The house dark theme — dark teal, warm text |
| **iSputnik Light** | The house light theme — soft paper and green |
| **Plain Dark** / **Plain Light** | Neutral greys, if you'd rather the app got out of the way |

### Devices

- **Send to e-reader** — see below.
- **Install the app** — add iSputnik to your phone's home screen. Installed, it
  gets a bottom nav and an offline **Downloads** screen, so books you download stay
  readable and listenable with no connection.

## Send to e-reader

Set the address your Kindle or Kobo receives documents at (something like
`you@kindle.com`, from your device's settings), and every ebook gets a **Send to
e-reader** button that mails the EPUB or PDF straight to it.

Three things have to line up, and it fails quietly if any is missing:

1. **Your device address** — Profile → Devices.
2. **The server can send email** — an administrator sets this up
   ([guide](email.md)). Without it the button tells you so.
3. **The server's address is on your device's approved-senders list** — Amazon and
   Kobo drop mail from anyone you haven't approved, without telling you. Add the
   **From address** from the server's email settings (ask your administrator) to
   the approved list in your Amazon or Kobo account.

If a book never arrives, number 3 is almost always why.

## The things you've saved

The rest of that menu is your own collection of pointers into the libraries.
Nothing here copies or moves a file — remove any of it and the original is
untouched.

| | What it holds | How things get there |
|---|---|---|
| **Shared with me** | Books, photos and albums other people have shared with your account | Someone else shares them; they appear here |
| **Favorites** | Anything worth finding again — audiobooks, ebooks and photos together | The heart on a book's page, or on a photo |
| **Bookmarks** | Places inside a book: a moment in an audiobook, a page in an ebook | The bookmark button while listening or reading |
| **Quotes** | Passages worth keeping, with the book and page they came from | Highlight text in the reader, or **Add quote** on any book |
| **Collections** | Lists you make yourself, which can mix audiobooks, ebooks and photos in one list | **Add to collection** from any item |
| **Downloads** | Books kept on this device for offline use *(installed app only)* | The download button on a book |

**Favorites vs Collections** is the usual question. Favorites is one flat list —
one tap, no thinking. A collection is a list you name and curate ("Car trips",
"Read with the kids"), and one item can sit in as many as you like.

Bookmarks and quotes both live inside books, but they answer different questions:
a bookmark is *where I was*, a quote is *what it said*.

Your place in a book isn't in any of these lists — it's saved automatically, and
picked up from the **Continue** row on the home screen, on whichever device you
carry on with.

## What only an administrator can do

Not everything about your account is yours to change:

- **Which libraries you can see** — access is granted per library.
- **Resetting your two-factor** if you've lost both your codes and your backup
  codes.
- **Your role** (whether you're an administrator at all).
- **Deactivating an account.**

If you're the only person here, you're the administrator too — those controls are
in the **Control panel**.
