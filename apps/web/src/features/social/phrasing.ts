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
