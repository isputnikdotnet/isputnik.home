# Two-factor authentication

Two-factor authentication (2FA) adds a second step to signing in: after your
password, you enter a short code from an app on your phone. Even if someone learns
your password, they can't get into your account without that code.

It's optional, but recommended — especially if your library is reachable from the
internet.

## What you'll need

An **authenticator app** on your phone. Any of these work:

- Google Authenticator
- Microsoft Authenticator
- Authy
- Apple Passwords (built into iPhone, iPad, and Mac)
- 1Password, Bitwarden, or most password managers

## Turning it on

1. Open **Profile** (your name → Profile).
2. Find **Two-factor authentication** and select **Set up two-factor**.
3. Enter your account password to confirm it's you.
4. **Scan the QR code** with your authenticator app. Can't scan? Type the key
   shown beneath the code into the app by hand.
5. Your app now shows a 6-digit code that changes every 30 seconds. Enter the
   current code and select **Turn on two-factor**.
6. **Save your backup codes** (see below), then select **Done**.

From now on, signing in asks for a code after your password.

## Backup codes — save these

When you turn on 2FA you're shown a set of **backup codes**. Each one lets you
sign in **once** if you don't have your phone — for example if it's lost or out of
battery.

- **Write them down or download them** and keep them somewhere safe — not next to
  your password.
- Each code works only once.
- You can get a fresh set anytime from Profile → Two-factor authentication →
  **Regenerate backup codes** (this cancels the old set).

## Signing in with 2FA

1. Enter your email and password as usual.
2. When asked, open your authenticator app and enter the current 6-digit code.
3. No phone? Enter one of your **backup codes** instead.

## Turning it off

Profile → Two-factor authentication → **Turn off**. You'll confirm your password,
and your account goes back to password-only.

## Locked out?

If you've lost your phone **and** your backup codes, ask an **administrator** to
reset two-factor on your account. Afterwards you can sign in with just your
password and set 2FA up again.

> **For administrators:** Control panel → **Users** → the person's row → the shield
> icon (**Reset two-factor**). This clears their authenticator and backup codes. It
> does not change their password or touch their content.
