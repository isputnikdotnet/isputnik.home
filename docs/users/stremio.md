# Watching in Stremio

[Stremio](https://www.stremio.com) is a free player for TVs, phones and
computers. iSputnik can appear in it as an add-on: the shows and films you can
see here, with their posters, episodes and subtitles, played on the TV in the
living room with its own remote.

Each person gets their own link. Stremio shows exactly the video libraries you
can open in iSputnik — nothing more — and a link can be revoked at any time.

> Video has to be set up on this server first (an administrator's job, in
> [Adding the games and video apps](apps.md)). Until it is, the Stremio card in
> Profile is not there.

## Creating your Stremio link

1. Open **Profile → Security** and find **Stremio**.
2. Choose **Create link** and name the device ("Living room TV"), so you can tell
   your links apart later.
3. The link is shown **once**. Choose **Install in Stremio** to open it in the
   Stremio app on this device, or copy the **Add-on link**, or scan the QR code
   with your phone.

The link works like a password for your videos: anyone who has it sees what you
see. Don't share it — make one per device instead.

**The link uses the address you made it on.** Everything Stremio fetches through
it — posters, films, subtitles — goes to the address you had open in iSputnik
when you chose Create link, and the dialog names it. If your server has two
addresses (say, one for home and one for outside), open iSputnik on the one the
TV should use and create the link there. Profile lists each link with its
address.

## Installing it in Stremio

In Stremio, open **Add-ons**, paste the link into the **Search or paste link**
box at the top, press **Enter** and choose **Install**. The add-on is called
**iSputnik**, followed by this server's address.

**On a TV, install it from your phone or computer instead.** Stremio keeps your
add-ons with your Stremio account, so installing on the phone puts it on every
device signed in to the same Stremio account — the TV included — the next time
Stremio starts there. Nothing has to be typed with a remote.

## What you'll see

On Stremio's **Board**:

- **Continue watching** — what you have started in iSputnik's own player.
- **A row per video library** you can open, named after the library (Stremio
  adds "- Movie" or "- Series" to each name).

Open a show for its seasons and episodes; Stremio offers the next episode when
one ends. **Search** finds titles in your libraries.

### Two ways to play a film

Most films offer one stream, **Original**: the file as it is, which Stremio plays
itself. A film in a format some TVs can't decode offers **Converted · H.264 for
TVs** first: the server converts it while you watch. It takes a few seconds to
start, and a little longer after a seek. If the original plays fine on your
device, choose it — it costs the server nothing.

### Subtitles

Subtitle tracks inside the file show in Stremio's own subtitle menu. Subtitle
files kept beside a film (`Film.ru.srt`) are offered too, by language.

## What Stremio doesn't do

- **Your place isn't kept here.** Stremio remembers where you stopped in its own
  account and resumes from there; iSputnik's own player doesn't hear about it.
  The other way round works: what you start in iSputnik shows up in Stremio's
  **Continue watching**.
- **It works at home.** By default a Stremio link works only on your home
  network. An administrator can change that.
- **One Stremio account is one person.** A TV signed in to your Stremio account
  sees your libraries, whoever holds the remote.

## Only iSputnik in Stremio

A new Stremio account comes with Stremio's own catalogs (popular films and
shows). Your iSputnik rows work alongside them. To see only iSputnik, uninstall
the other add-ons under **Add-ons → Installed**. Two of them, **Cinemeta** and
**Local Files**, can't be removed from Stremio's own screens; community "add-on
manager" tools can remove Cinemeta (or just its catalogs) by signing in to your
Stremio account. They are not made by Stremio or iSputnik — use one only if you
trust it with that sign-in. Local Files can stay: it shows nothing unless you
play files stored on that device.

## Revoking a link

**Profile → Security → Stremio** lists your links with when each was last used.
The bin icon revokes one: Stremio on that device stops showing this server's
videos at once. Your other links, and what you've watched, are not affected.

An administrator can revoke anyone's link — for a lost or given-away device — on
**Security → App access**, with Video chosen.

## For administrators

- **Stremio needs HTTPS.** It refuses an add-on on a plain `http://` address on
  your network, so a link only works where iSputnik is reached over HTTPS — see
  [Exposing your library to the internet](exposing-to-the-internet.md). Each link
  is built on the address it was created on (links made before 4.46.1 use
  `APP_URL`).
- **Two addresses, one behind Cloudflare?** A name proxied by Cloudflare reaches
  the server from the internet even inside the house, so *Home network only*
  refuses it — and Cloudflare's terms don't cover streaming video through its
  free proxy. Make Stremio links on the name that resolves to the server at home.
- **Where links work from** is the **Stremio** rule on **Security → App access →
  From where**, *Home network only* to start with. That works when your domain
  resolves to the server's own address inside the house (a local DNS entry on the
  router or Pi-hole): the TV's requests then come from your home network. Without
  that, a TV at home reaches the server through the router's public address and
  the rule refuses it — set the rule to *Trusted networks only* or *Anywhere*.
- **Who may use Stremio** is who may use Video (**Security → App access**), and
  which libraries each person sees is each library's own access, as for the
  Shows and Movies pages.
- **Converted streams** count towards **Settings → Video → Converting video**,
  like the browser player's.
- **Every install is its own add-on**, named and numbered after this server, so
  a member of two family servers can install both.
