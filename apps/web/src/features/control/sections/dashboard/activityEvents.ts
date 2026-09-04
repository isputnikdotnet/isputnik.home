import i18n from "../../../../i18n";

// Curated event lists for the Dashboard's detail tables. Full event names (not
// bare categories), matched exactly by the /api/logs event filter — see logs.ts.

// Every event that means someone got in, or tried and failed. "auth.mfa_verified"
// is a full sign-in: with two-factor on, the password step only logs
// "auth.mfa_required" and the session is issued when the code is accepted.
export const LOGIN_EVENTS = [
  "auth.login",
  "auth.passkey_login",
  "auth.mfa_verified",
  "auth.device_link_approved",
  "auth.login_failed",
  "auth.mfa_failed"
];

export const UPLOAD_EVENTS = ["library.gallery.uploaded", "library.ebook.book_uploaded", "library.audiobook.book_uploaded", "gallery.music.uploaded"];
export const DOWNLOAD_EVENTS = ["library.gallery.downloaded", "library.audiobook.downloaded", "library.ebook.downloaded"];
export const DELETE_EVENTS = ["library.gallery.deleted", "library.audiobook.deleted", "library.ebook.deleted", "library.item_trashed", "library.item_purged"];
export const ENGAGEMENT_EVENTS = ["library.audiobook.played", "library.ebook.read", "library.gallery.viewed"];

export const CONTENT_EVENTS = [...UPLOAD_EVENTS, ...DOWNLOAD_EVENTS, ...DELETE_EVENTS, ...ENGAGEMENT_EVENTS];

// A guest share link being opened: nobody signed in, but somebody came in, and
// the Sign-ins page lists it beside the sign-ins as its own kind.
export const GUEST_VISIT_EVENT = "share.accessed";

export function isGuestVisitEvent(event: string): boolean {
  return event === GUEST_VISIT_EVENT;
}

export function loginMethodLabel(event: string): string {
  switch (event) {
    case GUEST_VISIT_EVENT: return i18n.t("controlDash:events.methodShareLink");
    case "auth.login": return i18n.t("controlDash:events.methodPassword");
    case "auth.passkey_login": return i18n.t("controlDash:events.methodPasskey");
    case "auth.mfa_verified": return i18n.t("controlDash:events.methodPasswordTwoFactor");
    case "auth.mfa_failed": return i18n.t("controlDash:events.methodTwoFactorCode");
    case "auth.device_link_approved": return i18n.t("controlDash:events.methodDeviceLink");
    default: return "—";
  }
}

// The event name itself decides pass/fail — use this instead of comparing
// loginResultLabel()'s translated text, which is only for display.
export function isFailedLoginEvent(event: string): boolean {
  return event === "auth.login_failed" || event === "auth.mfa_failed";
}

export function loginResultLabel(event: string): string {
  if (isGuestVisitEvent(event)) return i18n.t("controlDash:events.resultGuest");
  return isFailedLoginEvent(event) ? i18n.t("controlDash:events.resultFailed") : i18n.t("controlDash:events.resultSuccess");
}
