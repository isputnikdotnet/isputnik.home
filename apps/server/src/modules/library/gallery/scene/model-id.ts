// The scene model this server's vectors are made with (docs/scene-search-plan.md).
// On its own, free of any import, so a module that only needs the id (the queue,
// the settings page) loads nothing else.

/** What the engine calls the model AND how it prepares its input. Stamped on
 *  every vector and scan marker: a different id means "made differently, does not
 *  compare", and the next ordinary scan re-embeds those photos. */
export const SCENE_MODEL = "siglip-base-patch16-224-q8/1";

/** Numbers in one vector. */
export const SCENE_DIMENSIONS = 768;

/** This pass's name in item_model_scans. */
export const SCENE_PASS = "scene";
