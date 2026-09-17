# Frequently asked questions

<!--
  Shown on the in-app Help page, not opened as a guide. Each "## " heading is a
  question and the text under it the answer. Keep answers to a few sentences and
  end on a link to the guide section that says it properly — `npm run check:ui`
  fails when one of those links points at a guide or heading that doesn't exist.
  A question only administrators need gets a line directly under its heading
  holding an HTML comment with the single word "admin", and members never see it.
-->

## How do I add photos to my library?

A gallery library shows whatever is in its folder, so photos copied there appear
after the next scan. If the library allows uploads, the upload button takes files
straight in and files them into dated folders. Prints you re-scan and photos
from relatives can go through the Photo Inbox first.

[Gallery › Uploading](library-gallery.md#uploading)

## I lost my phone — how do I sign in with two-factor turned on?

Use one of the backup codes you saved when you turned two-factor on — each one
signs you in once. Lost those too? Ask an administrator to reset two-factor on
your account, then set it up again.

[Two-factor authentication › Locked out?](two-factor-authentication.md#locked-out)

## How do I share a story with someone who has no account?

Open the story and choose **Send**, then **Share link**. That makes a guest link:
the story in any browser, no account needed, always showing it as it is now.

[Stories › Sharing a story](stories.md#sharing-a-story)

## Which ebook formats can I read in the app?

EPUB and FB2 open in the built-in reader, which keeps your place per book across
your devices. PDFs open too. A reading app such as KOReader can also download
your ebooks itself.

[Ebooks › Reading](library-ebooks.md#reading)

## Where do the things people send me end up?

On **For you**, in the menu with your name on it. Each row is one thing someone
put in front of you — a book, a photo, an album, or a question about some
photos — with the one button it needs.

[Sharing with family › For you](family-sharing.md#for-you)

## Can I sign in without a password?

Yes, with a passkey: your fingerprint, your face or your device's PIN. It's
optional, and your password and two-factor keep working as before.

[Passkeys › Adding one](passkeys.md#adding-one)

## How do I invite the rest of the family?
<!-- admin -->

In **Control panel → Members**, make an invite link for each person. They set
their own password, so you never handle it. Give people member accounts unless
they need to run the server.

[First run › Adding other people](first-run.md#adding-other-people)

## How do I back up my data?
<!-- admin -->

**Control panel → Maintenance → Backup** makes one now or on a schedule. A full
backup holds the database, the two-factor key and every cover; a minimal one
leaves out what a rescan can make again. Your media files are never in a
backup, and never touched.

[The control panel › Backup](control-panel.md#backup)

## Can I install iSputnik on my phone?

Yes — add it to your phone's home screen. Installed, it gets a bottom menu and a
**Downloads** screen, so books you download stay readable and listenable with no
connection.

[Your account › Devices](your-account.md#devices)

## Is it safe to open my library to the internet?
<!-- admin -->

It's built for a home network. Before sharing the address, put it behind HTTPS
and turn on the settings the guide lists — and finish the first-run setup while
you're still at home.

[Exposing your library to the internet › Checklist](exposing-to-the-internet.md#checklist)
