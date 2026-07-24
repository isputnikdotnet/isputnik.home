// Web-playable video conversion: the backlog query + batch enqueue that the weekly
// maintenance job drives (the ffmpeg run itself is not exercised — like the render
// tests, only the pure queue/selection logic).
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import {
  unplayableBacklogCount,
  enqueueTranscodeBatch,
  recordTranscodeFailure,
  MAX_TRANSCODE_ATTEMPTS,
  TRANSCODE_JOB_TYPE
} from "../src/modules/library/gallery/transcode.js";
import { getGalleryAsset } from "../src/modules/library/gallery/catalog.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

// Insert a gallery item + detail row with controlled playability/web-copy state.
function item(
  id: string,
  opts: { playable?: number | null; webKey?: string | null; attempts?: number; kind?: string; deleted?: boolean } = {}
) {
  const { playable = 0, webKey = null, attempts = 0, kind = "video", deleted = false } = opts;
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status, deleted_at) VALUES (?, 'GAL', 'gallery', ?, 'ready', ?)")
    .run(id, `${id}.mp4`, deleted ? new Date().toISOString() : null);
  db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path, playable, web_video_key, web_video_attempts, duration_seconds, size) VALUES (?, ?, ?, ?, ?, ?, 10, 1000)")
    .run(id, kind, `${id}.mp4`, playable, webKey, attempts);
}

const pendingItemIds = () =>
  (db.prepare("SELECT json_extract(payload,'$.itemId') AS id FROM jobs WHERE type = ? AND status = 'pending'").all(TRANSCODE_JOB_TYPE) as { id: string }[]).map((r) => r.id);

beforeEach(() => {
  resetDb();
  makeUser("u");
  makeLibrary("GAL", { createdBy: "u", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
});

describe("unplayable-video backlog", () => {
  it("counts only unplayable videos with no web copy, under the attempt cap, live", () => {
    item("needs");                                   // eligible
    item("playable", { playable: 1 });               // browser-playable already
    item("hasweb", { webKey: "videos/x/y-web.mp4" }); // already converted
    item("giveup", { attempts: MAX_TRANSCODE_ATTEMPTS }); // exhausted retries
    item("photo", { kind: "photo", playable: null }); // not a video
    item("gone", { deleted: true });                  // tombstoned
    expect(unplayableBacklogCount()).toBe(1);
  });
});

describe("enqueueTranscodeBatch", () => {
  it("queues up to the limit as numbered batches and skips already-queued items", () => {
    item("a"); item("b"); item("c");

    expect(enqueueTranscodeBatch(2)).toBe(2);
    expect(pendingItemIds().sort()).toEqual(["a", "b"]);
    // Batch numbering is recorded for the Tasks page.
    const first = JSON.parse((db.prepare("SELECT payload FROM jobs WHERE type = ? LIMIT 1").get(TRANSCODE_JOB_TYPE) as { payload: string }).payload);
    expect(first.batches).toBe(2);

    // Re-running skips a/b (already pending) and picks up the remaining c.
    expect(enqueueTranscodeBatch(5)).toBe(1);
    expect(pendingItemIds().sort()).toEqual(["a", "b", "c"]);

    // Nothing left to queue.
    expect(enqueueTranscodeBatch(5)).toBe(0);
  });
});

describe("recordTranscodeFailure", () => {
  it("bumps attempts and drops the item from the backlog at the cap", () => {
    item("bad");
    expect(unplayableBacklogCount()).toBe(1);
    for (let i = 0; i < MAX_TRANSCODE_ATTEMPTS; i += 1) recordTranscodeFailure("bad");
    expect((db.prepare("SELECT web_video_attempts a FROM gallery_details WHERE item_id='bad'").get() as { a: number }).a).toBe(MAX_TRANSCODE_ATTEMPTS);
    expect(unplayableBacklogCount()).toBe(0);
  });
});

describe("mapAsset reflects the web copy", () => {
  it("plays a converted video inline (playbackUrl + playable) while keeping the original for download", () => {
    item("conv", { playable: 0, webKey: "GAL/co/nv/conv-web.mp4" });
    const asset = getGalleryAsset("u", ["GAL"], "conv")!;
    expect(asset.playable).toBe(true);
    expect(asset.playbackUrl).toBe("/api/library/gallery/assets/conv/file?web=1");
    expect(asset.fileUrl).toBe("/api/library/gallery/assets/conv/file"); // download = original
  });

  it("an un-converted unplayable video stays download-only", () => {
    item("orig", { playable: 0 });
    const asset = getGalleryAsset("u", ["GAL"], "orig")!;
    expect(asset.playable).toBe(false);
    expect(asset.playbackUrl).toBe("/api/library/gallery/assets/orig/file");
  });
});
