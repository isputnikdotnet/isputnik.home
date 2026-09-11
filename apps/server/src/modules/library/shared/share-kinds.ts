// Share kinds the guest-link engine serves but does not own.
//
// shares/ is the guest-link engine for every module: tokens, rate limits and
// the public /api/share/:token routes. Library items and gallery sets are its
// own. A link whose resource belongs to another module — a story, today — is
// served through a kind that module registers here from its plugin, so the
// engine never imports it. (It used to import the stories module, which
// imported it back: a two-file import cycle.)
//
// A kind answers the questions the public routes ask of a link: the page it
// shows, which gallery items it may serve (membership IS the authorization), and
// what goes into its download-all zip. Routes that only one kind has — a story's
// narration clips — live with that kind's module.
//
// Imports nothing at runtime, so any file may depend on it.
import type { ResolvedShareLink } from "./share-access.js";

/** One gallery item a link may serve, with everything the media routes need. */
export interface ShareMediaItem {
  folder_path: string;
  kind: string;
  relative_path: string;
  mime_type: string | null;
  title: string | null;
  cover_storage_key: string | null;
  preview_storage_key: string | null;
  source_path: string;
}

/** One file of a link's download-all zip. */
export interface ShareFile {
  id: string;
  title: string | null;
  folder_path: string;
  relative_path: string;
  kind: string;
  source_path: string;
}

export interface ShareKind {
  /** share_links.module */
  module: string;
  /** What the activity log and the zip call it: "story". */
  noun: string;
  /** The public page's payload for this link, or null when it no longer serves
   *  (a deleted resource, a creator who lost access). `title` and `photoCount`
   *  are for the activity log. */
  buildPage: (link: ResolvedShareLink, token: string) => { payload: unknown; title: string; photoCount: number } | null;
  /** A gallery item this link may serve, or undefined — an id the link does not
   *  cover is indistinguishable from a missing file. */
  loadMediaItem: (link: ResolvedShareLink, itemId: string) => ShareMediaItem | undefined;
  /** Every file the link exposes, for the download-all zip. */
  listFiles: (link: ResolvedShareLink) => ShareFile[];
  /** The resource's own name, for the zip and the log when the link has no label. */
  title: (resourceId: string) => string | null;
}

const shareKinds = new Map<string, ShareKind>();

/** Register (or replace — a test may boot the plugin twice) a share kind. */
export function registerShareKind(kind: ShareKind): void {
  shareKinds.set(kind.module, kind);
}

export function getShareKind(module: string): ShareKind | undefined {
  return shareKinds.get(module);
}
