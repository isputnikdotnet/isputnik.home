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

import i18n from "../../i18n";

// Module-level helper (no hook access), so it goes through i18n directly. A
// switch (not a Record lookup) because entityType is a plain string, not a
// literal union — see docs/i18n-plan.md's template-literal-key pitfall.
function recommendVerb(entityType: string): string {
  switch (entityType) {
    case "audiobook": return i18n.t("user:phrase.recommend.audiobook");
    case "ebook": return i18n.t("user:phrase.recommend.ebook");
    case "gallery": return i18n.t("user:phrase.recommend.gallery");
    case "gallery_album": return i18n.t("user:phrase.recommend.galleryAlbum");
    case "gallery_slideshow": return i18n.t("user:phrase.recommend.gallerySlideshow");
    case "family_tree_person": return i18n.t("user:phrase.recommend.familyTreePerson");
    default: return i18n.t("user:phrase.recommend.fallback");
  }
}

/** "Dad wants you to read this" — the whole line, ready to render. */
export function recommendationLine(fromName: string, entityType: string): string {
  return `${fromName} ${recommendVerb(entityType)}`;
}

// ── The activity feed reads as sentences ────────────────────────────────────
//
// "Anna left a note on Dune" tells you what happened and invites you in; a
// title with a badge beside it makes you work it out. The subject's own title
// is rendered separately by the row, so these are the words around it.

export type ActivityKind = "note" | "album" | "slideshow" | "person" | "story" | "story_update";

/** The chapter a story update added, as the fields that name it. */
export interface ActivityChapter {
  id: string;
  title: string | null;
  /** The story's own word for a chapter ("Day"); null = plain "Chapter". */
  noun: string | null;
  number: number;
}

/** "Day 4" in the story's own words, else the chapter's title, else
 *  "Chapter 4" — the same precedence the story's reader uses. */
export function chapterName(chapter: ActivityChapter): string {
  if (chapter.noun) return `${chapter.noun} ${chapter.number}`;
  if (chapter.title) return chapter.title;
  return i18n.t("stories:chapter.number", { number: chapter.number });
}

// The title does not always come last. "Anna left a note on Dune" works with the
// name at the end; "Dad added to the family tree Grandma" does not — it has to be
// "Dad added Grandma to the family tree". So a phrase is two halves with the
// title between them, which the first version got wrong and real data caught the
// moment the feed was looked at.
function activityPhraseParts(kind: ActivityKind, detail?: string): { before: string; after: string } {
  switch (kind) {
    case "story_update":
      // "added Day 4 to" — the chapter is part of the verb phrase, the story
      // title is what the row renders after it.
      return {
        before: i18n.t("user:phrase.activity.storyUpdateBefore", { chapter: detail ?? "" }),
        after: i18n.t("user:phrase.activity.storyUpdateAfter")
      };
    case "note":
      return { before: i18n.t("user:phrase.activity.noteBefore"), after: i18n.t("user:phrase.activity.noteAfter") };
    case "album":
      return { before: i18n.t("user:phrase.activity.albumBefore"), after: i18n.t("user:phrase.activity.albumAfter") };
    case "slideshow":
      return {
        before: i18n.t("user:phrase.activity.slideshowBefore"),
        after: i18n.t("user:phrase.activity.slideshowAfter")
      };
    case "story":
      return { before: i18n.t("user:phrase.activity.storyBefore"), after: i18n.t("user:phrase.activity.storyAfter") };
    case "person":
      return { before: i18n.t("user:phrase.activity.personBefore"), after: i18n.t("user:phrase.activity.personAfter") };
    default:
      return {
        before: i18n.t("user:phrase.activity.fallbackBefore"),
        after: i18n.t("user:phrase.activity.fallbackAfter")
      };
  }
}

export interface ActivityPhrase {
  /** "Anna left a note on" — everything before the title. */
  before: string;
  /** "to the family tree", or empty when the title ends the sentence. */
  after: string;
}

export function activityPhrase(actorName: string, kind: ActivityKind, detail?: string): ActivityPhrase {
  const phrase = activityPhraseParts(kind, detail);
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
