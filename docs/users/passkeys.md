# Passkeys

A passkey lets you sign in with your fingerprint, your face, or your device's PIN
instead of typing a password. It's the fastest way to use iSputnik day to day —
especially on a phone, where typing a password and then hunting for a one-time code
is the whole reason people stop opening the app.

It's optional, and it doesn't replace anything: your password and
[two-factor authentication](two-factor-authentication.md) keep working exactly as
before.

## Why it's safer, not just quicker

A passkey isn't a password stored somewhere clever. It's a pair of keys: the secret
half never leaves your phone or laptop, and iSputnik only ever holds the public half
— which is useless to anyone who steals it.

That gives it two properties a password can't have:

- **It can't be phished.** A passkey only works on the real address of your library.
  A convincing fake page can't borrow it, no matter what you click.
- **It's already two factors.** Your device checks that *you* are the one unlocking
  it — that's the fingerprint or the face — before it will sign anything. So a
  passkey sign-in doesn't ask for a one-time code on top. It isn't skipping a step;
  the step already happened.

## Adding one

1. Open **Profile** (your name → Profile) and pick the **Security** tab.
2. Find **Passkeys** and select **Add passkey**.
3. Enter your account password to confirm it's you, and name the device so you can
   recognise it later ("iPhone", "work laptop").
4. Your device takes over — a fingerprint, a face scan, or a PIN prompt.

Add one on each device you actually use. They're per-device, though most phones and
laptops sync them (see below).

## Signing in

On the sign-in screen, select **Sign in with a passkey**. There's no email to type
— your device already knows which account it holds — and after the fingerprint or
face check you're straight in.

The password form is still there underneath, and still works.

## Losing a device

Most passkeys sync through your account's keychain — iCloud Keychain on Apple
devices, Google Password Manager on Android. A new phone signed in to the same
account gets your passkeys back automatically.

Some don't sync: a passkey created on a desktop browser or a hardware security key
usually lives on that device alone. The Passkeys list marks those **this device
only**, so you can tell at a glance which ones you'd lose.

If you lose every device that had one, nothing is locked: **sign in with your
password** (and your one-time code, if two-factor is on) and add a new passkey. An
administrator can also clear stale passkeys off your account from
Control panel → **Members** → **Users**.

Removing a passkey — yours or an admin clearing them — never affects your password
or two-factor setup.

## When passkeys aren't offered

If the Passkeys panel says they aren't available, it's the server's address, not
your device.

Browsers only allow passkeys on sites reached over **HTTPS at a domain name** — like
`https://library.example.com`. A library reached by IP address on the home network,
like `http://192.168.1.50:4000`, can't use them at all, and no browser setting
changes that.

Administrators: this is the same requirement as
[opening the library to the internet](exposing-to-the-internet.md). Once the server
is behind a proxy with a real hostname and `APP_URL` is set to the `https://` address,
passkeys appear on their own.

> One thing to watch: a passkey is tied to the exact hostname it was created on. If
> your family reaches the library at a domain from outside but by IP from the couch,
> passkeys will only work on the domain. Using the same hostname everywhere (split-DNS
> at home) keeps them working on both sides.
