# Setting up email

The server can send mail, but it doesn't have to. Nothing breaks without it —
three features simply stay unavailable.

Everything here lives in **Control panel → Settings → Email**, and it's admin-only.

## What email is used for

| | What it does | Without email |
|---|---|---|
| **Two-factor codes** | Lets people choose "Email" as their second factor and receive a 6-digit code per sign-in | The Email option is hidden. An authenticator app still works, and is the stronger choice anyway — see [Two-factor authentication](two-factor-authentication.md) |
| **Security alerts** | Warns you about locked accounts, auto-blocked addresses, a new admin, two-factor being turned off, repeated wrong codes, and sign-ins from a network an account has never used | The events are still recorded in the activity log — nobody is told about them as they happen |
| **Send to e-reader** | Mails an ebook to a Kindle or Kobo address | The button explains that mail isn't set up |

Account owners also get told when their own login email, password, or two-factor
setup changes — the alert that matters most, because it's how someone learns their
account was taken over.

## Before you start

You need an account on a mail service that will let this server send through it.
Three shapes work:

- **A mail provider you already use** — Gmail, Fastmail, iCloud and similar. Almost
  all of them now require an **app password**: a separate password made for one
  program, issued from your account's security settings. Your normal password will
  be rejected, and generating an app password usually requires two-factor to be on
  for that account first.
- **Your own SMTP server or relay** — anything on your network that accepts mail.
  Often no username or password at all.
- **A transactional mail service** — Postmark, Mailgun, Brevo and the like, if you
  want delivery reports and a reputation that isn't your personal inbox.

Mail from a home connection is often treated as spam. If alerts matter to you, send
through a provider rather than direct.

## Filling in the form

| Field | What to put | Notes |
|---|---|---|
| **SMTP host** | `smtp.example.com` | Your provider's outgoing server, from their help pages |
| **Port** | `587` or `465` | 587 is the common default |
| **Use implicit TLS** | Off for port 587, on for port 465 | This one trips people up — see below |
| **Username** | Usually your full email address | Leave blank for a relay that doesn't ask for one |
| **Password** | The app password | Stored on the server and never shown again |
| **From address** | `library@example.com` | Who the mail appears to be from. Required |
| **From name** | `iSputnik Library` | Optional; the friendly name beside the address |

**The TLS checkbox is the usual sticking point.** There are two ways to encrypt
SMTP, and they aren't interchangeable:

- **Port 587, checkbox off** — the connection starts plain and upgrades (STARTTLS).
  This is what most providers want.
- **Port 465, checkbox on** — encrypted from the first byte (implicit TLS).

Mismatch them and the test hangs until it times out rather than saying anything
useful. If a save-and-test times out, try the other combination before assuming the
password is wrong.

**From address** should be an address that mail service is actually allowed to send
as — usually the same account you're authenticating with. Providers reject, or spam
folders swallow, mail claiming to be from an address the sender has no right to.

Only **host**, **port** and **from address** are strictly required. Until all three
are filled in and saved, email counts as not configured and the features above stay
switched off.

## Save, then test

Select **Save**, then **Send test email**. The test goes to *your own* account
address, so check the inbox you sign in with.

The password field is left blank on the way back in — it shows `•••••••• (unchanged)`
once a password is stored. Leave it alone to keep the current one; type a new one to
replace it.

## When the test fails

| What you see | Usually means |
|---|---|
| *Configure and save email settings first* | You pressed test before save — the test uses the saved settings, not what's on screen |
| An authentication error | The provider wants an **app password**, not your normal one — or the username needs to be the full email address |
| A timeout, with no other detail | Port and TLS checkbox don't match (see above), or a firewall is blocking outbound mail on that port |
| *Invalid email settings* on save | The From address isn't a valid address, or the port is outside 1–65535 |
| The test succeeds but nothing arrives | Check the spam folder, then check the From address is one that account may send as |

The test reports the mail server's own refusal message when there is one — that
message is usually more specific than anything the app could invent, so it's worth
reading in full.

## After it works

- Anyone can now pick **Email** as their two-factor method
  ([guide](two-factor-authentication.md)). Point them at the authenticator-app
  option first: an emailed code is only as private as the inbox it lands in.
- You'll start receiving security alerts. If your library is reachable from the
  internet, these are the early warning that something is being tried — see
  [Exposing your library to the internet](exposing-to-the-internet.md).
- Ebook readers can set a device address in their profile and use **Send to
  e-reader** ([guide](library-ebooks.md)).

## A note on the password

The SMTP password is stored on the server, in the same database as everything else,
and it is never sent back to your browser. It is stored in a form the server can
read — it has to be, to log in to your mail provider.

Two consequences worth knowing: use an **app password** scoped to this one purpose
rather than your real account password, and remember that a database backup carries
that password with it. Keep backups somewhere you'd be comfortable keeping the
password itself.
