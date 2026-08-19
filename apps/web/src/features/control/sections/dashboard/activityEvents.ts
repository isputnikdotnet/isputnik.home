// Curated event lists for the Dashboard's detail tables. Full event names (not
// bare categories), matched exactly by the /api/logs event filter — see logs.ts.

export const LOGIN_EVENTS = ["auth.login", "auth.passkey_login", "auth.device_link_approved", "auth.login_failed"];

export const UPLOAD_EVENTS = ["library.gallery.uploaded", "library.ebook.book_uploaded", "library.audiobook.book_uploaded", "gallery.music.uploaded"];
export const DOWNLOAD_EVENTS = ["library.gallery.downloaded", "library.audiobook.downloaded", "library.ebook.downloaded"];
export const DELETE_EVENTS = ["library.gallery.deleted", "library.audiobook.deleted", "library.ebook.deleted", "library.item_trashed", "library.item_purged"];
export const ENGAGEMENT_EVENTS = ["library.audiobook.played", "library.ebook.read", "library.gallery.viewed"];

export const CONTENT_EVENTS = [...UPLOAD_EVENTS, ...DOWNLOAD_EVENTS, ...DELETE_EVENTS, ...ENGAGEMENT_EVENTS];

export function loginMethodLabel(event: string): string {
  switch (event) {
    case "auth.login": return "Password";
    case "auth.passkey_login": return "Passkey";
    case "auth.device_link_approved": return "Device link";
    default: return "—";
  }
}

export function loginResultLabel(event: string): "Success" | "Failed" {
  return event === "auth.login_failed" ? "Failed" : "Success";
}
