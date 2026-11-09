import i18n from "../../../../i18n";

// Curated event lists for the Dashboard's detail tables. Full event names (not
// bare categories), matched exactly by the /api/logs event filter — see logs.ts.

export const UPLOAD_EVENTS = ["library.gallery.uploaded", "library.ebook.book_uploaded", "library.audiobook.book_uploaded", "gallery.music.uploaded"];
export const DOWNLOAD_EVENTS = ["library.gallery.downloaded", "library.audiobook.downloaded", "library.ebook.downloaded"];
export const DELETE_EVENTS = ["library.gallery.deleted", "library.audiobook.deleted", "library.ebook.deleted", "library.item_trashed", "library.item_purged"];
export const ENGAGEMENT_EVENTS = ["library.audiobook.played", "library.ebook.read", "library.gallery.viewed", "library.video.played", "games.match_started"];

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
// A refusal at a locked account counts as a failure too: the person was kept
// out. It keeps a result label of its own, since nothing was checked.
export function isFailedLoginEvent(event: string): boolean {
  return event === "auth.login_failed" || event === "auth.mfa_failed" || event === "auth.login_locked";
}

export function loginResultLabel(event: string): string {
  if (isGuestVisitEvent(event)) return i18n.t("controlDash:events.resultGuest");
  if (event === "auth.login_locked") return i18n.t("controlDash:events.resultLocked");
  return isFailedLoginEvent(event) ? i18n.t("controlDash:events.resultFailed") : i18n.t("controlDash:events.resultSuccess");
}
