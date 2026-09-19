// A story with no cover chosen wears the first PHOTOGRAPH it shows. Four
// queries want that same fallback — the story index (list.ts), the Recycle Bin
// (crud.ts), a shelf's card (collections.ts) and the subjects registry
// (social/subjects.ts) — and each wraps it in its own correlation and library
// bound, so what they share lives here instead of being copied a fourth time.
//
// "Shows" means a single photo block (story_blocks.entity_id) OR one member of
// a photo group (story_block_items) — the LEFT JOIN plus COALESCE covers both
// in one pass, and the position triple orders them the way the page reads:
// chapter, then block, then the author's order inside the group.
//
// Deliberately gallery-only, and deliberately not every gallery block: an audio
// block is entity_type 'gallery' too, and a recording's embedded cover art must
// never become the story's card. A group with no members joins to nothing and
// drops out on its own.
//
// No placeholders in here, so a call site's argument list is unaffected.

/** Joins reaching the item behind a cover-worthy block, single or grouped. */
export const COVER_BLOCK_JOINS = `
          LEFT JOIN story_block_items ON story_block_items.block_id = story_blocks.id
          JOIN library_items ON library_items.id = COALESCE(story_block_items.item_id, story_blocks.entity_id)
            AND library_items.deleted_at IS NULL
          JOIN item_metadata ON item_metadata.item_id = library_items.id`;

/** Which blocks may lend a cover, and the item actually having artwork. The
 *  caller's own correlation and library bound go around this. */
export const COVER_BLOCK_WHERE = `((story_blocks.kind = 'media' AND story_blocks.entity_type = 'gallery')
              OR story_blocks.kind = 'photos')
            AND item_metadata.cover_storage_key IS NOT NULL`;

/** Reading order: chapter, block, then position within the group. */
export const COVER_BLOCK_ORDER = `ORDER BY story_chapters.position, story_blocks.position, story_block_items.position LIMIT 1`;
