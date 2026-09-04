import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { navigate } from "../../router";
import type { StoryBlockKind, StoryChapter, StoryDetail } from "./types";

// Every mutation the editor can make, plus the story it edits. Writes go
// straight to the server and the story is re-read afterwards: a story is a
// handful of rows, and re-reading keeps positions, hydration and availability
// honest without a second source of truth in the client.
export function useStoryEditor(id: string) {
  const { t } = useTranslation(["common", "stories"]);
  const [story, setStory] = useState<StoryDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const payload = await api<{ story: StoryDetail }>(`/api/stories/${id}`);
    setStory(payload.story);
    return payload.story;
  }, [id]);

  useEffect(() => {
    setStory(null);
    setError("");
    reload().catch((err) => setError(err instanceof Error ? err.message : t("stories:errors.load")));
  }, [reload]);

  // One place where a write is attempted, reported and followed by a re-read —
  // so no caller can forget any of the three.
  const run = useCallback(async (work: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    setError("");
    try {
      await work();
      await reload();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
      return false;
    } finally {
      setBusy(false);
    }
  }, [reload]);

  const patchStory = useCallback((fields: Record<string, unknown>) =>
    run(() => api(`/api/stories/${id}`, { method: "PATCH", body: JSON.stringify(fields) }), t("stories:errors.save")),
  [id, run, t]);

  const removeStory = useCallback(async () => {
    setBusy(true);
    try {
      await api(`/api/stories/${id}`, { method: "DELETE" });
      navigate("/stories");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("stories:errors.delete"));
      setBusy(false);
    }
  }, [id, t]);

  const setTags = useCallback((tags: string[]) =>
    run(() => api(`/api/stories/${id}/tags`, { method: "PUT", body: JSON.stringify({ tags }) }), t("stories:errors.save")),
  [id, run, t]);

  // Returns the new chapter's id: the editor shows one chapter at a time, so
  // adding one has to be able to walk straight into it.
  const addChapter = useCallback(async () => {
    const created: { id: string | null } = { id: null };
    await run(async () => {
      const payload = await api<{ chapterId: string }>(`/api/stories/${id}/chapters`, {
        method: "POST",
        body: JSON.stringify({})
      });
      created.id = payload.chapterId;
    }, t("stories:errors.save"));
    return created.id;
  }, [id, run, t]);

  const patchChapter = useCallback((chapterId: string, fields: Record<string, unknown>) =>
    run(
      () => api(`/api/stories/${id}/chapters/${chapterId}`, { method: "PATCH", body: JSON.stringify(fields) }),
      t("stories:errors.save")
    ),
  [id, run, t]);

  const removeChapter = useCallback((chapterId: string) =>
    run(() => api(`/api/stories/${id}/chapters/${chapterId}`, { method: "DELETE" }), t("stories:errors.delete")),
  [id, run, t]);

  // Chapters are dragged into order in the editor's sidebar, so the whole list
  // arrives at once — there is no one-step-at-a-time move to reconcile.
  const reorderChapters = useCallback((orderedIds: string[]) =>
    run(
      () => api(`/api/stories/${id}/chapters/reorder`, { method: "PATCH", body: JSON.stringify({ orderedIds }) }),
      t("stories:errors.save")
    ),
  [id, run, t]);

  // Blocks are added where they were asked for: the editor's insert points sit
  // between blocks, so afterId places the new ones there instead of at the end.
  // Several at once — a handful of photos picked together — are created in the
  // order they were chosen and placed as one run, so the story is re-read once
  // and the author never sees them land one by one. Creation and placement are
  // one action from the author's side, so they are one run() here.
  const addBlocks = useCallback((
    chapterId: string,
    kind: StoryBlockKind,
    fieldsList: Record<string, unknown>[],
    afterId?: string
  ) =>
    run(async () => {
      const createdIds: string[] = [];
      for (const fields of fieldsList) {
        const created = await api<{ blockId: string }>(`/api/stories/${id}/blocks`, {
          method: "POST",
          body: JSON.stringify({ chapterId, kind, ...fields })
        });
        createdIds.push(created.blockId);
      }
      const chapter = story?.chapters.find((entry) => entry.id === chapterId);
      if (!afterId || !chapter || createdIds.length === 0) return;
      const ordered = chapter.blocks.map((block) => block.id).filter((blockId) => !createdIds.includes(blockId));
      const at = ordered.indexOf(afterId);
      if (at < 0) return;
      ordered.splice(at + 1, 0, ...createdIds);
      await api(`/api/stories/${id}/blocks/reorder`, {
        method: "PATCH",
        body: JSON.stringify({ chapterId, orderedIds: ordered })
      });
    }, t("stories:errors.save")),
  [id, run, story, t]);

  const addBlock = useCallback((
    chapterId: string,
    kind: StoryBlockKind,
    fields: Record<string, unknown> = {},
    afterId?: string
  ) => addBlocks(chapterId, kind, [fields], afterId), [addBlocks]);

  const patchBlock = useCallback((blockId: string, fields: Record<string, unknown>) =>
    run(
      () => api(`/api/stories/${id}/blocks/${blockId}`, { method: "PATCH", body: JSON.stringify(fields) }),
      t("stories:errors.save")
    ),
  [id, run, t]);

  const removeBlock = useCallback((blockId: string) =>
    run(() => api(`/api/stories/${id}/blocks/${blockId}`, { method: "DELETE" }), t("stories:errors.delete")),
  [id, run, t]);

  // The whole order at once, as a drag inside a chapter produces it.
  const reorderBlocks = useCallback((chapterId: string, orderedIds: string[]) =>
    run(
      () => api(`/api/stories/${id}/blocks/reorder`, {
        method: "PATCH",
        body: JSON.stringify({ chapterId, orderedIds })
      }),
      t("stories:errors.save")
    ),
  [id, run, t]);

  const moveBlock = useCallback((chapter: StoryChapter, blockId: string, direction: -1 | 1) => {
    const ordered = reorder(chapter.blocks.map((block) => block.id), blockId, direction);
    if (!ordered) return Promise.resolve(false);
    return run(
      () => api(`/api/stories/${id}/blocks/reorder`, {
        method: "PATCH",
        body: JSON.stringify({ chapterId: chapter.id, orderedIds: ordered })
      }),
      t("stories:errors.save")
    );
  }, [id, run, t]);

  // Move a block to the neighbouring chapter, appended at its end. The reorder
  // endpoint reparents every id it is given, so this is the same call.
  const moveBlockToChapter = useCallback((blockId: string, target: StoryChapter) =>
    run(
      () => api(`/api/stories/${id}/blocks/reorder`, {
        method: "PATCH",
        body: JSON.stringify({
          chapterId: target.id,
          orderedIds: [...target.blocks.map((block) => block.id), blockId]
        })
      }),
      t("stories:errors.save")
    ),
  [id, run, t]);

  return {
    story,
    error,
    busy,
    setError,
    reload,
    patchStory,
    removeStory,
    setTags,
    addChapter,
    patchChapter,
    removeChapter,
    reorderChapters,
    addBlock,
    addBlocks,
    patchBlock,
    removeBlock,
    reorderBlocks,
    moveBlock,
    moveBlockToChapter
  };
}

/** The id list with `id` shifted one place, or null when it can't move. */
function reorder(ids: string[], id: string, direction: -1 | 1): string[] | null {
  const index = ids.indexOf(id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ids.length) return null;
  const next = [...ids];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
