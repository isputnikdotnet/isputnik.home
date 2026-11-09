# The TV app

**iSputnik TV** puts your films and shows on the television, with its own remote and
no browser. Your place is shared with the website: stop a film on the TV and pick it
up on your laptop, or the other way round. It opens to your own home screen, with
nothing on it but what's on your server.

Everyone in the house can have their own place on the same TV.

> Video has to be set up on this server first (an administrator's job, in
> [Adding the games and video apps](apps.md)). Until it is, the app has nothing to show.

## Which TVs it runs on

- **Android TV and Google TV** sets and boxes.
- **Fire TV** sticks and sets that run Fire OS.
- **Not** the newest Fire TV sticks that run Vega OS, which can't run Android apps. If
  you're buying a TV or a stick for this, buy Android TV or Google TV.
- Samsung and LG sets have their own systems, and aren't supported.

The app isn't in Amazon's or Google's store, so it's installed by hand, once. After
that it offers its own updates.

## Installing it

The file is always at the same address:

```text
https://github.com/isputnikdotnet/isputnik.tv/releases/latest/download/iSputnik-TV.apk
```

### On a Fire TV

1. From the Fire TV's search, find and install **Downloader** (by AFTVnews). It's free.
2. Open **Settings → My Fire TV → Developer options → Install unknown apps**, and turn
   it on for **Downloader**.

   If **Developer options** isn't there, open **Settings → My Fire TV → About**, press
   Select seven times on the first line, and go back.
3. Open Downloader, type the address above, and choose **Go**.
4. Choose **Install** when the download finishes, then **Open**. Downloader will offer to
   delete the file afterwards, and you can let it.

iSputnik TV now appears among your apps.

### On an Android TV or Google TV

1. Install **Downloader** from the Play Store.
2. Open it, type the address above, and allow it to install apps when the TV asks.
3. Choose **Install**, then **Open**.

### From a computer

If you already use `adb`, turn on ADB debugging on the TV and:

```bash
adb connect <tv address>:5555
adb install -r iSputnik-TV.apk
```

## Signing in

The first time, the app asks for your server's address: the one you use in a browser at
home, like `https://hub.example.com` or `http://192.168.1.20:4000`. Type it once with the
remote and choose **Connect**.

It then shows a code and a QR. Scan it with your phone, check the code matches, and enter
your password on the phone. Nothing but the address is typed on the TV, and your password
never goes near it. This is the same [Link a device](link-a-device.md) used for any screen,
and the same rule applies: it has to be done from your home network.

## Finding your way around

- **Home** has what you were watching, then what's new, with a large card for the thing
  you're most likely to want next.
- **Movies** and **Shows** are everything, with sorting and film sets.
- **Search** is at the top, too.

Back always returns to the card you left. In the player:

- **Select** pauses and plays, **left** and **right** jump back and forward, **Down** shows the
  controls, and **Back** leaves. Your place is saved as you go.
- The controls choose **Audio** and **Subtitles**, and the app remembers your language for
  next time.
- **Skip intro** appears where the server knows where the intro is, and when the credits start
  the next episode offers itself.

If the TV can't play a file directly, it switches to the server's converted copy by itself.
You may notice a pause of a few seconds.

## Several people on one TV

Choose your name at the top right, then **Add a person**, and link them with their own phone
in the same way. From then on the app asks **Who's watching?** when it opens. Each person
gets their own place, their own Continue watching, and only the libraries they can open.

There's no PIN on that screen. Anyone holding the remote can choose anyone linked on this TV.
If a child's account is limited, those limits only hold while no less limited account is linked
here.

## Profiles: Kids, Russian, Classic

Profiles are the household's ways of watching video, like on Netflix. An administrator sets
them up on the website's video page: **Customize**, then the **Profiles** tab. Each has a name
and a colour, and can only show less than the person signed in may see:

- **Video libraries**: only the ones ticked. Search, title pages and sets show nothing else.
- **Its own rows**: on the same **Customize**, choose the profile's tab. Until rows are saved
  there, a profile shows the household's rows, from its own libraries only.

Every TV offers the same profiles. When the app opens, **Who's watching?** shows the name the
TV is linked with and each profile. To change later, choose the name at the top right. The TV
remembers the profile it's left in, even after a restart. In a browser, the video page has the
same choice under **Watching as**; there it changes only Video, never photos, books or the rest
of the site.

A **restricted** profile is meant for children. The app doesn't ask who's watching when it
opens in one. To keep it closed, the administrator sets a **PIN** on the same Profiles tab
(4 to 8 digits; it costs their password). Getting into Kids is free; getting out needs the PIN.
On the TV that covers switching to another profile or to the linked name, choosing another
person linked on the TV, linking someone new, and unlinking the TV; tiles that need it wear a
lock. After 5 wrong tries entry locks for 15 minutes. Forgot the PIN? Set a new one on the
website. The TV can also be removed from **Profile › Security** on your own device at any time.

Without a PIN, anyone can switch away from a restricted profile, and the Profiles tab warns
about that. Profiles are only changed by an administrator on the website, never on a TV, so the
remote can't make Kids show more. A child with their own tablet or browser should have their
own account rather than a profile: a profile doesn't lock the rest of the website.

Each profile has its own **Continue watching**, watched marks and **My list**, the same on
every TV and browser whoever is signed in: Kids' history is Kids'. Without a profile, they're
your own, as before. Deleting a profile deletes its history and list too.

## Its colours

The app wears the theme you chose in **Profile → Appearance**, and there's nothing to set on the
TV. Each person on a TV gets their own, and a change shows the next time you come back to the app.

It's always a dark version, because a white screen is hard on a dark room: the light themes keep
their colour but on a dark background, and **System** shows as Plain Dark. **Who's watching?** and
the sign-in screens are nobody's in particular, so they stay navy and teal.

## Updates

When there's a new version, **Update available** appears at the top of the screen when the
app is opened. It doesn't interrupt anything. Choose it, then **Update now**.

The first time, the TV has to allow iSputnik TV to install its own updates. The app says where
that setting is: on a Fire TV it's **My Fire TV → Developer options → Install unknown apps**.
You do this once per TV. Everyone stays linked through an update, and nothing is lost.

The check goes to GitHub, and sends nothing about you or your server.

## Taking a TV out of use

- **To sign one person out:** choose your name at the top right, then **Unlink … from this TV**,
  and press it a second time to confirm. Anyone else linked here stays.
- **From elsewhere,** if the TV is gone: **Profile → Security** lists it as a linked device.
  **Revoke device** signs it out straight away. Do this if a TV is sold or lost.
- **To remove the app,** uninstall it from the TV's settings. That forgets everyone on it.

## If something's wrong

**"Unable to reach your iSputnik."** The TV can't get to your server. Check the server is up,
and that the TV is on the network you expect. **Try again** checks again, and **Change address**
lets you correct it.

**It's back on the code screen.** That person's sign-in ended: someone revoked it in Profile, or
it reached the end of its life (a year, unless your administrator changed it). Link again.

**"Devices can only be linked from your home network."** The TV is reaching the server from
outside, or through a proxy it doesn't trust. See [Link a device](link-a-device.md#for-administrators).

**A film stutters, or there's picture but no sound.** Open the sound track choice in the player
and try another. Some TVs can't play every track, and the app falls back when it can tell.

**An address starting with `http://`.** The screen warns about this. It's fine inside your own
home, but your sign-in is not encrypted on the way, so use `https://` if you have it.

## For administrators

The app uses nothing that isn't already on the server: Link a device for signing in, and the
same routes the website calls, so every permission applies as it does there. A linked TV can't
open the control panel, whoever's account it is.

**Point TVs at your home address, not one through Cloudflare's free proxy.** Streaming video
through that proxy can break Cloudflare's terms, and it's slower than the house network anyway.

An address behind a reverse proxy needs `TRUST_PROXY_HOPS`, or linking refuses. See
[Link a device](link-a-device.md#for-administrators).
