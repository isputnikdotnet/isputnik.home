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

export function loginMethodLabel(event: string): string {
  switch (event) {
    case "auth.login": return "Password";
    case "auth.passkey_login": return "Passkey";
    case "auth.mfa_verified": return "Password + two-factor";
    case "auth.mfa_failed": return "Two-factor code";
    case "auth.device_link_approved": return "Device link";
    default: return "—";
  }
}

export function loginResultLabel(event: string): "Success" | "Failed" {
  return event === "auth.login_failed" || event === "auth.mfa_failed" ? "Failed" : "Success";
}
