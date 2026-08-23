// What one family member is actually asking of another.
//
// Everything used to say "sent you this", whatever it was. The app knows
// whether the thing is read, listened to or watched, so it should say so —
// "Dad wants you to read this" lands as a person talking; "Dad sent you this"
// lands as software reporting an event. For a household where not everyone is
// comfortable with computers, that difference is most of the feature.
//
// One place, because three surfaces say it: the card under "Waiting for you",
// the Home row, and (in its own words, being a different medium) the email.

const VERBS: Record<string, string> = {
  audiobook: "wants you to listen to this",
  ebook: "wants you to read this",
  gallery: "wants you to see this",
  gallery_album: "wants you to see these photos",
  gallery_slideshow: "wants you to watch this",
  family_tree_person: "wants you to see this"
};

/** "Dad wants you to read this" — the whole line, ready to render. */
export function recommendationLine(fromName: string, entityType: string): string {
  return `${fromName} ${VERBS[entityType] ?? "sent you this"}`;
}

/** The same intent with no name, for tight spaces: "Read this". */
const SHORT: Record<string, string> = {
  audiobook: "Listen",
  ebook: "Read",
  gallery: "Look",
  gallery_album: "Look",
  gallery_slideshow: "Watch",
  family_tree_person: "Look"
};

export function recommendationVerb(entityType: string): string {
  return SHORT[entityType] ?? "Open";
}

// ── The activity feed reads as sentences ────────────────────────────────────
//
// "Anna left a note on Dune" tells you what happened and invites you in; a
// title with a badge beside it makes you work it out. The subject's own title
// is rendered separately by the row, so these are the words around it.

export type ActivityKind = "note" | "album" | "slideshow" | "person";

// The title does not always come last. "Anna left a note on Dune" works with the
// name at the end; "Dad added to the family tree Grandma" does not — it has to be
// "Dad added Grandma to the family tree". So a phrase is two halves with the
// title between them, which the first version got wrong and real data caught the
// moment the feed was looked at.
const PHRASES: Record<ActivityKind, { before: string; after: string }> = {
  note: { before: "left a note on", after: "" },
  album: { before: "made the album", after: "" },
  slideshow: { before: "made the slideshow", after: "" },
  person: { before: "added", after: "to the family tree" }
};

export interface ActivityPhrase {
  /** "Anna left a note on" — everything before the title. */
  before: string;
  /** "to the family tree", or empty when the title ends the sentence. */
  after: string;
}

export function activityPhrase(actorName: string, kind: ActivityKind): ActivityPhrase {
  const phrase = PHRASES[kind] ?? { before: "did something with", after: "" };
  return { before: `${actorName} ${phrase.before}`, after: phrase.after };
}

/** How long ago, in the fewest words that are still true. */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const minutes = Math.floor((Date.now() - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days`;
  return new Date(iso).toLocaleDateString();
}
