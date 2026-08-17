# Two-factor authentication

Two-factor authentication (2FA) adds a second step to signing in: after your
password, you enter a short one-time code. Even if someone learns your password,
they can't get into your account without that code.

It's optional, but recommended — especially if your library is reachable from the
internet.

> If your library is reached over HTTPS at a domain name, look at
> [passkeys](passkeys.md) first. A passkey signs you in with a fingerprint or face
> and counts as both factors at once, so there's no code to type. Two-factor is
> still worth having as the fallback for when you're signing in with your password.

## Choose how you get your codes

You pick one of two methods when you turn 2FA on.

| | **Authenticator app** | **Email** |
|---|---|---|
| What you need | An app on your phone | Nothing to install |
| Works offline | Yes | No |
| Where the code comes from | Your phone, every 30 seconds | Your inbox, one per sign-in |
| Security | Stronger | Weaker — see below |

**Authenticator app** is the safer choice: the code is generated on your phone and
never travels anywhere. Any of these work:

- Google Authenticator
- Microsoft Authenticator
- Authy
- Apple Passwords (built into iPhone, iPad, and Mac)
- 1Password, Bitwarden, or most password managers

**Email** is easier — nothing to set up or carry — but it's the weaker of the two:
the code travels by email, so **anyone who can read your inbox can get into your
library**. It also depends on the server being able to send email; if email breaks,
your backup codes are the way in.

> The email option only appears if an administrator has set up email on the server
> (Control panel → **Settings** → **Email** — see [Setting up email](email.md)). Codes
> go to the same address you sign in with.

## Turning it on

1. Open **Profile** (your name → Profile) and pick the **Security** tab — see
   [Your account](your-account.md) for what else lives there.
2. Find **Two-factor authentication** and select **Set up two-factor**.
3. Choose **Authenticator app** or **Email**, enter your account password to
   confirm it's you, and select **Continue**.
4. Prove the codes reach you:
   - **Authenticator app** — scan the QR code with your app. Can't scan? Type the
     key shown beneath it into the app by hand. Your app now shows a 6-digit code
     that changes every 30 seconds; enter the current one.
   - **Email** — check your inbox for a 6-digit code and enter it. Nothing
     arrived? Select **Send another code**.
5. Select **Turn on two-factor**.
6. **Save your backup codes** (see below), then select **Done**.

From now on, signing in asks for a code after your password.

To switch methods later, turn 2FA off and set it up again with the other one.

## Backup codes — save these

When you turn on 2FA you're shown a set of **backup codes**. Each one lets you
sign in **once** when your second factor is out of reach — a lost phone, a flat
battery, or an inbox you can't get to.

- **Write them down or download them** and keep them somewhere safe — not next to
  your password.
- Each code works only once.
- You can get a fresh set anytime from Profile → Two-factor authentication →
  **Regenerate backup codes** (this cancels the old set).

If you chose the email method, these matter more than usual: they're what gets you
in when the server can't send mail.

## Signing in with 2FA

1. Enter your email and password as usual.
2. When asked, enter the 6-digit code:
   - **Authenticator app** — open the app and read the current code.
   - **Email** — check your inbox. The code lasts about 10 minutes and works once.
     If it doesn't arrive, select **Send another code** (allowed a couple of times
     per sign-in; after that, start over from your password).
3. No code? Enter one of your **backup codes** instead.

## Turning it off

Profile → Two-factor authentication → **Turn off**. You'll confirm your password,
and your account goes back to password-only.

## When the server requires it anyway

An administrator can require a second factor for **every** sign-in from outside
the home's trusted networks (Control panel → **Security** → **Policies** →
**Two-factor sign-in**). With that policy on:

- Accounts that have two-factor set up are asked for their usual code.
- Accounts that **don't** get a one-time code **emailed to their sign-in
  address** — no setup needed, but your inbox has to be reachable. Setting up a
  proper second factor (or a [passkey](passkeys.md)) is still better.
- If the server can't send email, an account without two-factor can't sign in
  from outside at all — sign in from home and set one up first.
- At home, on a trusted network, nothing changes.

## Locked out?

If you've lost your second factor **and** your backup codes, ask an
**administrator** to reset two-factor on your account. Afterwards you can sign in
with just your password and set 2FA up again.

> **For administrators:** Control panel → **Members** → **Users** → the person's row → the shield
> icon (**Reset two-factor**). This clears their method and backup codes. It does
> not change their password or touch their content.
