// What every story route file shares: the id and date shapes their bodies use, and
// the two guards every write goes through.
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { hydrateEntities } from "../social/subjects.js";
import { partialDateSchema } from "../familytree/persons.js";
import { BLOCK_ENTITY_TYPE, GALLERY_ENTITY_TYPE, type StoryRow, type StoryBlockKind } from "./stories.js";
import { getStory, canEditStory, canViewStory } from "./access.js";

export const optionalDate = partialDateSchema.nullable().optional();
export const entityId = z.string().trim().min(1).max(64);

export const reorderSchema = z.object({
  orderedIds: z.array(entityId).min(1).max(500)
});

// Load + authorize a story for a write. Members can list stories, so "exists
// but not yours" is a plain 403 (nothing is hidden by saying so); a draft
// someone else owns is invisible, hence 404 from the read guard below.
export const editableStory = (id: string, user: { id: string; role: string }, reply: FastifyReply): StoryRow | null => {
  const story = getStory(id);
  if (!story || !canViewStory(story, user)) {
    reply.code(404).send({ error: "Story not found" });
    return null;
  }
  if (!canEditStory(story, user)) {
    reply.code(403).send({ error: "Only the story's author or an admin can change it." });
    return null;
  }
  return story;
};

// A reference block may only point at something the author can actually
// reach, so a story can never become a backdoor to hidden content. Text and
// map blocks carry no reference and skip the check.
export const referenceIsReachable = (
  kind: StoryBlockKind,
  id: string | null | undefined,
  user: { id: string; role: string },
  // Book blocks carry their own type; everything else derives it from kind.
  explicitType?: string | null
): boolean => {
  const entityType = explicitType ?? BLOCK_ENTITY_TYPE[kind];
  if (!entityType) return true;
  if (!id) return false;
  // Audio validates as a gallery asset here (the v2 model — a new block can
  // only ever reference a library recording). Legacy 'story_audio' rows are
  // read-path only: nothing can create or re-point one any more.
  return Boolean(hydrateEntities([{ entityType, entityId: id }], user).get(`${entityType}:${id}`)?.available);
};

// The same rule over a list: every photo of a group has to be one the author can
// actually reach, or a group would be the backdoor a single reference isn't.
// One hydration for the whole list — a plate of photos is one question.
export const galleryItemsAreReachable = (
  itemIds: string[],
  user: { id: string; role: string }
): boolean => {
  if (itemIds.length === 0) return true;
  const hydrated = hydrateEntities(
    itemIds.map((id) => ({ entityType: GALLERY_ENTITY_TYPE, entityId: id })),
    user
  );
  return itemIds.every((id) => hydrated.get(`${GALLERY_ENTITY_TYPE}:${id}`)?.available);
};
