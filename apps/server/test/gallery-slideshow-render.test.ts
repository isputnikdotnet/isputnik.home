import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { kindForExtension } from "../src/modules/library/gallery/media.js";
import {
  createSlideshow,
  getSlideshow,
  addSlideshowItems,
  reorderSlideshowItems,
  updateSlideshow,
  setSlideshowRenderState,
  setSlideshowMovieAsset,
  getSlideshowRenderItems
} from "../src/modules/library/gallery/slideshows.js";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import {
  buildFfmpegArgs,
  segmentsFor,
  enqueueSlideshowRender,
  renderProgressPercent,
  saveMovieToLibrary,
  movieRelativePathFor,
  reconcileOrphanedRenders,
  deleteSlideshowRender,
  escapeFilterPath,
  TITLE_CARD_SECONDS,
  RANDOM_XFADES,
  RENDER_JOB_TYPE,
  type Segment,
  type TitleCard
} from "../src/modules/library/gallery/slideshow-render.js";
import { thumbnailPathSettingKey, thumbnailStorageKey, thumbnailAbsolutePath } from "../src/modules/library/shared/thumbnail.js";
import { getRenderLibraryId, setRenderLibraryId } from "../src/modules/library/gallery/slideshow-settings.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

function asset(relativePath: string, takenAtIso: string, kind = kindForExtension(`.${relativePath.split(".").pop()}`)!) {
  const extension = `.${relativePath.split(".").pop()}`;
  return {
    absolutePath: `/src/GAL/${relativePath}`, relativePath, fileName: relativePath.split("/").pop()!,
    extension, kind, size: 1000, modifiedAtMs: Date.parse(takenAtIso)
  };
}

const creator = { id: "creator", role: "member" };

beforeEach(() => {
  resetDb();
  makeUser("creator");
  makeLibrary("GAL", { createdBy: "creator", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
});

const segs = (dwells: number[]): Segment[] => dwells.map((d, i) => ({ file: `/img${i}.jpg`, dwell: d, isVideo: false }));

describe("render filtergraph", () => {
  it("a single photo maps straight through with no transition", () => {
    const { args, total } = buildFfmpegArgs(segs([4]), "crossfade", null, "/out.mp4");
    expect(total).toBe(4);
    expect(args).toContain("[v0]");
    expect(args.join(" ")).not.toContain("xfade");
  });

  it("each slide holds the screen for its full dwell (inputs padded by the transition)", () => {
    const { args, total } = buildFfmpegArgs(segs([4, 4, 4]), "crossfade", null, "/out.mp4");
    // Inputs run dwell + T so the photo-to-photo cadence equals the 4s setting.
    expect(args.join(" ")).toContain("-loop 1 -t 6.000 -i /img0.jpg");
    // Transitions start one dwell apart: 4, then 8 — i.e. a photo every 4s.
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("xfade=transition=fade:duration=2:offset=4.000");
    expect(filter).toContain("xfade=transition=fade:duration=2:offset=8.000");
    expect(total).toBe(3 * 4 + 2); // N·dwell + one transition tail
  });

  it("'none' concatenates unpadded — no overlap to compensate for", () => {
    const { args, total } = buildFfmpegArgs(segs([4, 4, 4]), "none", null, "/out.mp4");
    expect(args.join(" ")).toContain("-loop 1 -t 4.000 -i /img0.jpg");
    expect(total).toBe(12);
  });

  it("'random' varies the xfade per boundary via the injected picker", () => {
    const picks = ["circleopen", "wipeleft"];
    const { args } = buildFfmpegArgs(segs([4, 4, 4]), "random", null, "/o.mp4", 2, (i) => picks[i]);
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("xfade=transition=circleopen:duration=2:offset=4.000");
    expect(filter).toContain("xfade=transition=wipeleft:duration=2:offset=8.000");
  });

  it("a slideshow's transition length drives xfade duration, offsets, and total", () => {
    const { args, total } = buildFfmpegArgs(segs([6, 6, 6]), "crossfade", null, "/o.mp4", 4);
    const filter = args[args.indexOf("-filter_complex") + 1];
    // Inputs run 6+4=10; transitions start a full 6s dwell apart.
    expect(filter).toContain("xfade=transition=fade:duration=4:offset=6.000");
    expect(filter).toContain("xfade=transition=fade:duration=4:offset=12.000");
    expect(total).toBe(3 * 6 + 4);
    // Out-of-range values clamp to the 0.5–5 window rather than corrupting the graph.
    const clamped = buildFfmpegArgs(segs([6, 6]), "crossfade", null, "/o.mp4", 99);
    expect(clamped.args[clamped.args.indexOf("-filter_complex") + 1]).toContain("duration=5");
  });

  it("a lone slide is never padded (nothing to transition with)", () => {
    const { args, total } = buildFfmpegArgs(segs([4]), "crossfade", null, "/o.mp4", 2);
    expect(args.join(" ")).toContain("-loop 1 -t 4.000 -i /img0.jpg");
    expect(total).toBe(4);
  });

  it("'random' default picker draws only from the curated set", () => {
    const { args } = buildFfmpegArgs(segs([4, 4, 4, 4]), "random", null, "/o.mp4", 2);
    const filter = args[args.indexOf("-filter_complex") + 1];
    const names = [...filter.matchAll(/xfade=transition=([a-z]+):/g)].map((m) => m[1]);
    expect(names).toHaveLength(3);
    for (const name of names) expect(RANDOM_XFADES).toContain(name);
  });

  it("'dipblack' renders as ffmpeg's fadeblack (dip to black)", () => {
    const filter = buildFfmpegArgs(segs([4, 4]), "dipblack", null, "/o.mp4").args.join(" ");
    expect(filter).toContain("xfade=transition=fadeblack");
  });

  it("'slide' uses slideleft, 'none' concatenates with no overlap", () => {
    expect(buildFfmpegArgs(segs([4, 4]), "slide", null, "/o.mp4").args.join(" ")).toContain("slideleft");
    const none = buildFfmpegArgs(segs([4, 4, 4]), "none", null, "/o.mp4");
    expect(none.total).toBe(12); // no overlap
    expect(none.args.join(" ")).toContain("concat=n=3");
  });

  it("'kenburns' renders as a crossfade (zoompan is too slow to render)", () => {
    const filter = buildFfmpegArgs(segs([4, 4]), "kenburns", null, "/o.mp4").args.join(" ");
    expect(filter).toContain("xfade=transition=fade");
    expect(filter).not.toContain("zoompan");
  });

  it("muxes a music input with an out-fade when a track is given", () => {
    const { args } = buildFfmpegArgs(segs([4, 4]), "crossfade", "/bed.flac", "/o.mp4");
    const joined = args.join(" ");
    expect(joined).toContain("-stream_loop -1 -i /bed.flac");
    expect(joined).toContain("afade=t=out");
    expect(joined).toContain("-c:a aac");
    expect(joined).toContain("-shortest");
  });

  it("clamps a photo's on-screen dwell to 1..30s", () => {
    const built = segmentsFor([
      { id: "a", kind: "photo", relative_path: "a.jpg", source_path: "/s", dwell_seconds: 0.2, duration_seconds: null },
      { id: "b", kind: "photo", relative_path: "b.jpg", source_path: "/s", dwell_seconds: 99, duration_seconds: null },
      { id: "c", kind: "photo", relative_path: "c.jpg", source_path: "/s", dwell_seconds: null, duration_seconds: null }
    ], 5);
    expect(built.map((s) => s.dwell)).toEqual([1, 30, 5]); // floored / capped / slide default
    expect(built.every((s) => !s.isVideo)).toBe(true);
  });

  it("a video plays its own length, capped at VIDEO_CAP (20s)", () => {
    const built = segmentsFor([
      { id: "v1", kind: "video", relative_path: "v.mp4", source_path: "/s", dwell_seconds: null, duration_seconds: 8 },
      { id: "v2", kind: "video", relative_path: "long.mp4", source_path: "/s", dwell_seconds: null, duration_seconds: 400 }
    ], 5);
    expect(built[0].dwell).toBe(8);   // clip's own length
    expect(built[1].dwell).toBe(20);  // capped
    expect(built.every((s) => s.isVideo)).toBe(true);
  });

  it("reads a video input for its dwell (no -loop), photos loop a still", () => {
    const joined = buildFfmpegArgs([
      { file: "/a.jpg", dwell: 4, isVideo: false },
      { file: "/v.mp4", dwell: 6, isVideo: true }
    ], "crossfade", null, "/o.mp4").args.join(" ");
    // Inputs are padded by the 2s transition: 4→6 for the photo, 6→8 for the clip.
    expect(joined).toContain("-loop 1 -t 6.000 -i /a.jpg");
    expect(joined).toContain("-t 8.000 -i /v.mp4");
    expect(joined).not.toContain("-loop 1 -t 8.000 -i /v.mp4");
  });
});

describe("opening title card", () => {
  const card: TitleCard = { textFile: "/tmp/title.txt", subTextFile: "/tmp/sub.txt", fontFile: "D:\\fonts\\DejaVuSans.ttf" };

  it("prepends a black lavfi card with two drawtext lines and shifts the chain", () => {
    const { args, total } = buildFfmpegArgs(segs([4, 4]), "crossfade", null, "/o.mp4", 2, undefined, card);
    const joined = args.join(" ");
    // Card input = 3s on screen + the 2s transition it hands off through.
    expect(joined).toContain("-f lavfi -t 5.000 -i color=c=black:s=1920x1080:r=30");
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter.match(/drawtext=/g)).toHaveLength(2);
    expect(filter).toContain("textfile='/tmp/title.txt'");
    expect(filter).toContain("textfile='/tmp/sub.txt'");
    expect(filter).toContain("fontfile='D\\:/fonts/DejaVuSans.ttf'");
    // Card holds 3s, then a photo every 4s: transitions at 3 and 7.
    expect(filter).toContain("xfade=transition=fade:duration=2:offset=3.000");
    expect(filter).toContain("xfade=transition=fade:duration=2:offset=7.000");
    expect(total).toBe(3 + 4 + 4 + 2); // card + both dwells + one transition tail
  });

  it("shifts the music input index past the card", () => {
    const { args } = buildFfmpegArgs(segs([4, 4]), "crossfade", "/bed.flac", "/o.mp4", 2, undefined, card);
    expect(args.join(" ")).toContain("-map 3:a"); // 2 slides + card → music is input 3
  });

  it("without a card everything keeps its original shape", () => {
    const { args } = buildFfmpegArgs(segs([4, 4]), "crossfade", "/bed.flac", "/o.mp4", 2);
    const joined = args.join(" ");
    expect(joined).not.toContain("lavfi");
    expect(joined).not.toContain("drawtext");
    expect(joined).toContain("-map 2:a");
  });

  it("the card still holds its full time behind a long transition", () => {
    const { args } = buildFfmpegArgs(segs([6]), "crossfade", null, "/o.mp4", 5, undefined, card);
    expect(args.join(" ")).toContain(`-t ${(TITLE_CARD_SECONDS + 5).toFixed(3)} -i color=c=black`);
    // First photo starts appearing only after the card's full 3 seconds.
    expect(args[args.indexOf("-filter_complex") + 1]).toContain("offset=3.000");
  });

  it("escapes Windows paths for the filtergraph", () => {
    expect(escapeFilterPath("D:\\x y\\f.ttf")).toBe("D\\:/x y/f.ttf");
    expect(escapeFilterPath("/plain/path.txt")).toBe("/plain/path.txt");
  });
});

describe("render items include photos and videos in order", () => {
  it("keeps videos and follows presentation order, tagging each kind", async () => {
    const p1 = (await ingestGalleryAsset("GAL", asset("p1.jpg", "2024-01-01T00:00:00Z"), false))!;
    const vid = (await ingestGalleryAsset("GAL", asset("clip.mp4", "2024-01-02T00:00:00Z"), false))!;
    const p2 = (await ingestGalleryAsset("GAL", asset("p2.jpg", "2024-01-03T00:00:00Z"), false))!;
    const slideshow = createSlideshow(creator, "S");
    addSlideshowItems(slideshow.id, new Set(["GAL"]), [p2, vid, p1]); // append order

    const items = getSlideshowRenderItems(["GAL"], getSlideshow(slideshow.id)!);
    expect(items.map((i) => i.id)).toEqual([p2, vid, p1]); // video kept, order preserved
    expect(items.find((i) => i.id === vid)!.kind).toBe("video");
    expect(items.every((i) => i.source_path.length > 0)).toBe(true);
  });
});

describe("enqueue + progress", () => {
  it("queues a render job and marks the slideshow queued", () => {
    const slideshow = createSlideshow(creator, "S");
    const jobId = enqueueSlideshowRender(slideshow, "creator");
    expect(getSlideshow(slideshow.id)!.render_status).toBe("queued");
    expect(getSlideshow(slideshow.id)!.render_job_id).toBe(jobId);
    const job = db.prepare("SELECT type, status FROM jobs WHERE id = ?").get(jobId) as { type: string; status: string };
    expect(job.type).toBe(RENDER_JOB_TYPE);
    expect(job.status).toBe("pending");
  });

  it("releases a slideshow stuck 'rendering' when its job is cancelled (no prior movie → draft)", () => {
    const slideshow = createSlideshow(creator, "S");
    const jobId = enqueueSlideshowRender(slideshow, "creator");
    setSlideshowRenderState(slideshow.id, { status: "rendering", error: null });
    // Cancel = the job is failed and no longer active.
    db.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(jobId);

    expect(reconcileOrphanedRenders()).toBe(1);
    expect(getSlideshow(slideshow.id)!.render_status).toBe("draft");
  });

  it("restores the previous movie ('ready') when a re-render is cancelled", () => {
    const slideshow = createSlideshow(creator, "S");
    // A prior successful render left an output on disk.
    setSlideshowRenderState(slideshow.id, { status: "ready", outputStorageKey: "slideshows/x/y.mp4", outputBytes: 100 });
    const jobId = enqueueSlideshowRender(slideshow, "creator"); // re-render → queued
    setSlideshowRenderState(slideshow.id, { status: "rendering", error: null });
    db.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(jobId);

    expect(reconcileOrphanedRenders()).toBe(1);
    expect(getSlideshow(slideshow.id)!.render_status).toBe("ready");
  });

  it("leaves a slideshow alone while its render job is still active", () => {
    const slideshow = createSlideshow(creator, "S");
    enqueueSlideshowRender(slideshow, "creator"); // job is 'pending' (active)
    setSlideshowRenderState(slideshow.id, { status: "rendering", error: null });

    expect(reconcileOrphanedRenders()).toBe(0);
    expect(getSlideshow(slideshow.id)!.render_status).toBe("rendering");
  });

  it("reads a live encode percentage from the job payload", () => {
    const slideshow = createSlideshow(creator, "S");
    const jobId = enqueueSlideshowRender(slideshow, "creator");
    db.prepare("UPDATE jobs SET payload = ? WHERE id = ?")
      .run(JSON.stringify({ progress: { processed: 30, total: 120 } }), jobId);
    expect(renderProgressPercent(jobId)).toBe(25);
    expect(renderProgressPercent(null)).toBeNull();
  });

  it("a settings edit or a reorder flags a ready movie out of date (stays visible)", async () => {
    const a = (await ingestGalleryAsset("GAL", asset("a.jpg", "2024-01-01T00:00:00Z"), false))!;
    const b = (await ingestGalleryAsset("GAL", asset("b.jpg", "2024-01-02T00:00:00Z"), false))!;
    const slideshow = createSlideshow(creator, "S");
    addSlideshowItems(slideshow.id, new Set(["GAL"]), [a, b]);

    setSlideshowRenderState(slideshow.id, { status: "ready", outputStorageKey: "slideshows/x/y.mp4", outputBytes: 100 });
    updateSlideshow(slideshow.id, { slideSeconds: 6 });
    // The movie stays 'ready' (still served) but is flagged stale.
    expect(getSlideshow(slideshow.id)!.render_status).toBe("ready");
    expect(getSlideshow(slideshow.id)!.render_stale).toBe(1);

    // Re-rendering (or any setSlideshowRenderState) clears the flag.
    setSlideshowRenderState(slideshow.id, { status: "ready" });
    expect(getSlideshow(slideshow.id)!.render_stale).toBe(0);

    reorderSlideshowItems(slideshow.id, [b, a]);
    expect(getSlideshow(slideshow.id)!.render_status).toBe("ready");
    expect(getSlideshow(slideshow.id)!.render_stale).toBe(1);

    // Enqueuing a re-render clears it too.
    enqueueSlideshowRender(getSlideshow(slideshow.id)!, "creator");
    expect(getSlideshow(slideshow.id)!.render_stale).toBe(0);
  });

  it("edits don't touch render_stale when there's no ready movie", async () => {
    const a = (await ingestGalleryAsset("GAL", asset("a.jpg", "2024-01-01T00:00:00Z"), false))!;
    const slideshow = createSlideshow(creator, "S");
    addSlideshowItems(slideshow.id, new Set(["GAL"]), [a]);
    updateSlideshow(slideshow.id, { slideSeconds: 6 }); // still draft
    expect(getSlideshow(slideshow.id)!.render_status).toBe("draft");
    expect(getSlideshow(slideshow.id)!.render_stale).toBe(0);
  });
});

describe("default movie library setting", () => {
  it("stores and clears the default library", () => {
    expect(getRenderLibraryId()).toBeNull();
    setRenderLibraryId("GAL", "creator");
    expect(getRenderLibraryId()).toBe("GAL");
    setRenderLibraryId(null, "creator");
    expect(getRenderLibraryId()).toBeNull();
  });

  it("ignores a target that isn't an existing gallery library", () => {
    makeLibrary("AUD", { createdBy: "creator", type: "audiobook" });
    setRenderLibraryId("AUD", "creator"); // not a gallery library
    expect(getRenderLibraryId()).toBeNull();

    setRenderLibraryId("GAL", "creator");
    db.prepare("DELETE FROM libraries WHERE id = 'GAL'").run(); // library removed
    expect(getRenderLibraryId()).toBeNull();
  });
});

describe("saveMovieToLibrary path selection", () => {
  const base = { name: "Summer 2024", movie_library_id: null, movie_relative_path: null };

  it("files a first render under 'Slideshow movies/<name>.mp4'", () => {
    expect(movieRelativePathFor(base, "GAL", () => false)).toBe("Slideshow movies/Summer 2024.mp4");
  });

  it("reuses the stored path when re-rendering into the SAME library (no duplicate)", () => {
    const prior = { name: "Summer 2024", movie_library_id: "GAL", movie_relative_path: "Slideshow movies/Summer 2024.mp4" };
    // Even when the file already exists (a re-render overwrites it), the path is reused.
    expect(movieRelativePathFor(prior, "GAL", () => true)).toBe("Slideshow movies/Summer 2024.mp4");
  });

  it("picks a fresh path when the default library changed since the last render", () => {
    const prior = { name: "Summer 2024", movie_library_id: "OTHER", movie_relative_path: "Slideshow movies/Summer 2024.mp4" };
    expect(movieRelativePathFor(prior, "GAL", () => false)).toBe("Slideshow movies/Summer 2024.mp4");
  });

  it("follows a renamed slideshow: the next render saves under the new name", () => {
    const renamed = { name: "New trip", movie_library_id: "GAL", movie_relative_path: "Slideshow movies/Old trip.mp4" };
    const onDisk = new Set(["Slideshow movies/Old trip.mp4"]); // only the old movie exists
    expect(movieRelativePathFor(renamed, "GAL", (rel) => onDisk.has(rel))).toBe("Slideshow movies/New trip.mp4");
  });

  it("keeps its own ' (2)' file when the original name collision still exists", () => {
    const prior = { name: "Trip", movie_library_id: "GAL", movie_relative_path: "Slideshow movies/Trip (2).mp4" };
    // "Trip.mp4" is an unrelated file; "Trip (2).mp4" is OUR movie — not a collision.
    const onDisk = new Set(["Slideshow movies/Trip.mp4", "Slideshow movies/Trip (2).mp4"]);
    expect(movieRelativePathFor(prior, "GAL", (rel) => onDisk.has(rel))).toBe("Slideshow movies/Trip (2).mp4");
  });

  it("disambiguates against an existing unrelated file", () => {
    const taken = new Set(["Slideshow movies/Summer 2024.mp4"]);
    expect(movieRelativePathFor(base, "GAL", (rel) => taken.has(rel))).toBe("Slideshow movies/Summer 2024 (2).mp4");
  });

  it("sanitizes illegal characters and falls back for an empty name", () => {
    expect(movieRelativePathFor({ ...base, name: "Trip: Rome/Paris" }, "GAL", () => false)).toBe("Slideshow movies/Trip Rome Paris.mp4");
    expect(movieRelativePathFor({ ...base, name: "..." }, "GAL", () => false)).toBe("Slideshow movies/slideshow.mp4");
  });

  it("does nothing (and doesn't touch the slideshow) when no default library is set", async () => {
    const item = (await ingestGalleryAsset("GAL", asset("m.jpg", "2024-01-01T00:00:00Z"), false))!;
    const slideshow = createSlideshow(creator, "S");
    addSlideshowItems(slideshow.id, new Set(["GAL"]), [item]);

    const result = await saveMovieToLibrary(getSlideshow(slideshow.id)!, "slideshows/x/y.mp4");
    expect(result.saved).toBe(false);
    const row = getSlideshow(slideshow.id)!;
    expect(row.movie_library_id).toBeNull();
    expect(row.movie_relative_path).toBeNull();
    expect(row.movie_item_id).toBeNull();
  });
});

describe("random transition persistence", () => {
  it("persists transition = 'random' (the schema CHECK allows it)", () => {
    const slideshow = createSlideshow(creator, "S");
    updateSlideshow(slideshow.id, { transition: "random" });
    expect(getSlideshow(slideshow.id)!.transition).toBe("random");
  });

  it("persists transition = 'dipblack' (the schema CHECK allows it)", () => {
    const slideshow = createSlideshow(creator, "S");
    updateSlideshow(slideshow.id, { transition: "dipblack" });
    expect(getSlideshow(slideshow.id)!.transition).toBe("dipblack");
  });

  it("persists transitionSeconds and defaults new slideshows to 2", () => {
    const slideshow = createSlideshow(creator, "S");
    expect(slideshow.transition_seconds).toBe(2);
    updateSlideshow(slideshow.id, { transitionSeconds: 3.5 });
    expect(getSlideshow(slideshow.id)!.transition_seconds).toBe(3.5);
    // Other fields update without touching it.
    updateSlideshow(slideshow.id, { slideSeconds: 6 });
    expect(getSlideshow(slideshow.id)!.transition_seconds).toBe(3.5);
  });
});

describe("migration 14: widen the transition CHECK", () => {
  it("rebuilds an old gallery_slideshows in place, preserving rows and the child FK", () => {
    // A v13-era database: gallery_slideshows WITHOUT 'random' in the CHECK (movie_*
    // columns already added by v13), with a slideshow and a child item present.
    const scratch = new Database(":memory:");
    // The migration's restore runs with FKs ON (schema.sql sets the pragma), so the
    // fixture provides the referenced user and item in minimal tables — schema.sql
    // skips them via IF NOT EXISTS and only migration 14 runs at user_version 13. FKs
    // stay OFF during fixture setup because the remaining parent tables don't exist
    // until migrate() has applied schema.sql.
    scratch.pragma("foreign_keys = OFF");
    scratch.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, password_hash TEXT, display_name TEXT, role TEXT);
      INSERT INTO users (id) VALUES ('u1');
      CREATE TABLE library_items (id TEXT PRIMARY KEY, library_id TEXT, type TEXT, folder_path TEXT, status TEXT);
      INSERT INTO library_items (id) VALUES ('i1');
      CREATE TABLE gallery_slideshows (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        source_kind    TEXT NOT NULL DEFAULT 'manual' CHECK (source_kind IN ('manual', 'memory', 'album')),
        source_ref     TEXT,
        music_track_id TEXT REFERENCES gallery_music_tracks(id) ON DELETE SET NULL,
        transition     TEXT NOT NULL DEFAULT 'crossfade'
                         CHECK (transition IN ('none', 'crossfade', 'fade', 'slide', 'kenburns')),
        slide_seconds  REAL NOT NULL DEFAULT 4,
        render_status  TEXT NOT NULL DEFAULT 'draft'
                         CHECK (render_status IN ('draft', 'queued', 'rendering', 'ready', 'failed')),
        render_job_id  TEXT REFERENCES jobs(id) ON DELETE SET NULL,
        output_storage_key TEXT,
        output_bytes   INTEGER,
        rendered_at    TEXT,
        render_error   TEXT,
        movie_library_id    TEXT REFERENCES libraries(id) ON DELETE SET NULL,
        movie_relative_path TEXT,
        movie_item_id       TEXT REFERENCES library_items(id) ON DELETE SET NULL,
        created_by     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE gallery_slideshow_items (
        slideshow_id  TEXT NOT NULL REFERENCES gallery_slideshows(id) ON DELETE CASCADE,
        item_id       TEXT NOT NULL,
        position      REAL NOT NULL,
        dwell_seconds REAL,
        added_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (slideshow_id, item_id)
      );
      INSERT INTO gallery_slideshows (id, name, transition, created_by) VALUES ('s1', 'Trip', 'kenburns', 'u1');
      INSERT INTO gallery_slideshow_items (slideshow_id, item_id, position) VALUES ('s1', 'i1', 1);
    `);
    scratch.pragma("user_version = 13"); // only migration 14 should run

    migrate(scratch);

    // The row survived the rebuild and 'random' is now writable.
    const row = scratch.prepare("SELECT name, transition FROM gallery_slideshows WHERE id = 's1'").get() as { name: string; transition: string };
    expect(row).toEqual({ name: "Trip", transition: "kenburns" });
    scratch.prepare("UPDATE gallery_slideshows SET transition = 'random' WHERE id = 's1'").run(); // would throw under the old CHECK
    // The child kept its row and its FK still targets gallery_slideshows (not _old).
    expect((scratch.prepare("SELECT COUNT(*) AS n FROM gallery_slideshow_items").get() as { n: number }).n).toBe(1);
    const itemsSql = (scratch.prepare("SELECT sql FROM sqlite_master WHERE name = 'gallery_slideshow_items'").get() as { sql: string }).sql;
    expect(itemsSql).toContain("REFERENCES gallery_slideshows(");
    expect(scratch.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE '%_backup'").get()).toBeUndefined();
    scratch.close();
  });

  it("migration 15 repairs a child table left pointing at gallery_slideshows_old", () => {
    // The state v14's first, flawed rebuild left behind: parent already widened, but
    // the child's FK rewritten to the dropped _old table (every insert failed).
    const scratch = new Database(":memory:");
    scratch.pragma("foreign_keys = OFF");
    scratch.exec(`
      -- Minimal parent whose CHECK already allows every value, so only migration 15
      -- (the child repair under test) runs — the CHECK-widening rebuilds all skip.
      CREATE TABLE gallery_slideshows (
        id TEXT PRIMARY KEY, name TEXT NOT NULL,
        transition TEXT NOT NULL DEFAULT 'crossfade'
          CHECK (transition IN ('none', 'crossfade', 'fade', 'slide', 'kenburns', 'dipblack', 'random')),
        created_by TEXT NOT NULL
      );
      CREATE TABLE gallery_slideshow_items (
        slideshow_id  TEXT NOT NULL REFERENCES "gallery_slideshows_old"(id) ON DELETE CASCADE,
        item_id       TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
        position      REAL NOT NULL,
        dwell_seconds REAL,
        added_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (slideshow_id, item_id)
      );
      CREATE INDEX idx_gallery_slideshow_items_item ON gallery_slideshow_items (item_id);
      INSERT INTO gallery_slideshows (id, name, created_by) VALUES ('s1', 'S', 'u1');
      CREATE TABLE library_items (id TEXT PRIMARY KEY, library_id TEXT, type TEXT, folder_path TEXT, status TEXT);
      INSERT INTO library_items (id) VALUES ('i1');
    `);
    scratch.pragma("user_version = 14"); // only migration 15 should run

    migrate(scratch);

    // The FK targets gallery_slideshows again and inserts work.
    const itemsSql = (scratch.prepare("SELECT sql FROM sqlite_master WHERE name = 'gallery_slideshow_items'").get() as { sql: string }).sql;
    expect(itemsSql).not.toContain("gallery_slideshows_old");
    expect(itemsSql).toContain("REFERENCES gallery_slideshows(");
    scratch.prepare("INSERT INTO gallery_slideshow_items (slideshow_id, item_id, position) VALUES ('s1', 'i1', 1)").run();
    scratch.close();
  });

  it("migration 18 widens the CHECK to allow 'dipblack', preserving rows and the child FK", () => {
    // A v17-era database: 'random' already allowed, transition_seconds and movie_*
    // present, but no 'dipblack' — with a slideshow and a child item to survive.
    const scratch = new Database(":memory:");
    scratch.pragma("foreign_keys = OFF");
    scratch.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, password_hash TEXT, display_name TEXT, role TEXT);
      INSERT INTO users (id) VALUES ('u1');
      CREATE TABLE library_items (id TEXT PRIMARY KEY, library_id TEXT, type TEXT, folder_path TEXT, status TEXT);
      INSERT INTO library_items (id) VALUES ('i1');
      CREATE TABLE gallery_slideshows (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        source_kind    TEXT NOT NULL DEFAULT 'manual' CHECK (source_kind IN ('manual', 'memory', 'album')),
        source_ref     TEXT,
        music_track_id TEXT REFERENCES gallery_music_tracks(id) ON DELETE SET NULL,
        transition     TEXT NOT NULL DEFAULT 'crossfade'
                         CHECK (transition IN ('none', 'crossfade', 'fade', 'slide', 'kenburns', 'random')),
        slide_seconds  REAL NOT NULL DEFAULT 4,
        transition_seconds REAL NOT NULL DEFAULT 2,
        render_status  TEXT NOT NULL DEFAULT 'draft'
                         CHECK (render_status IN ('draft', 'queued', 'rendering', 'ready', 'failed')),
        render_job_id  TEXT REFERENCES jobs(id) ON DELETE SET NULL,
        output_storage_key TEXT,
        output_bytes   INTEGER,
        rendered_at    TEXT,
        render_error   TEXT,
        movie_library_id    TEXT REFERENCES libraries(id) ON DELETE SET NULL,
        movie_relative_path TEXT,
        movie_item_id       TEXT REFERENCES library_items(id) ON DELETE SET NULL,
        created_by     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE gallery_slideshow_items (
        slideshow_id  TEXT NOT NULL REFERENCES gallery_slideshows(id) ON DELETE CASCADE,
        item_id       TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
        position      REAL NOT NULL,
        dwell_seconds REAL,
        added_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (slideshow_id, item_id)
      );
      CREATE INDEX idx_gallery_slideshow_items_item ON gallery_slideshow_items (item_id);
      INSERT INTO gallery_slideshows (id, name, transition, transition_seconds, created_by) VALUES ('s1', 'Trip', 'random', 3.5, 'u1');
      INSERT INTO gallery_slideshow_items (slideshow_id, item_id, position) VALUES ('s1', 'i1', 1);
    `);
    scratch.pragma("user_version = 17"); // only migration 18 should run

    migrate(scratch);

    const row = scratch.prepare("SELECT name, transition, transition_seconds FROM gallery_slideshows WHERE id = 's1'")
      .get() as { name: string; transition: string; transition_seconds: number };
    expect(row).toEqual({ name: "Trip", transition: "random", transition_seconds: 3.5 });
    scratch.prepare("UPDATE gallery_slideshows SET transition = 'dipblack' WHERE id = 's1'").run(); // would throw under the old CHECK
    expect((scratch.prepare("SELECT COUNT(*) AS n FROM gallery_slideshow_items").get() as { n: number }).n).toBe(1);
    const itemsSql = (scratch.prepare("SELECT sql FROM sqlite_master WHERE name = 'gallery_slideshow_items'").get() as { sql: string }).sql;
    expect(itemsSql).toContain("REFERENCES gallery_slideshows(");
    expect(scratch.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE '%_backup'").get()).toBeUndefined();
    scratch.close();
  });

  it("leaves an already-widened table alone (fresh databases)", () => {
    const scratch = new Database(":memory:");
    migrate(scratch); // fresh: schema.sql already contains 'random'; v14's guard skips
    scratch.prepare("INSERT INTO users (id, email, password_hash, display_name, role) VALUES ('u1', 'u@x', 'x', 'u', 'member')").run();
    scratch.prepare("INSERT INTO gallery_slideshows (id, name, transition, created_by) VALUES ('s1', 'S', 'random', 'u1')").run();
    expect((scratch.prepare("SELECT transition FROM gallery_slideshows WHERE id = 's1'").get() as { transition: string }).transition).toBe("random");
    scratch.close();
  });
});

describe("setSlideshowMovieAsset", () => {
  it("records where the movie was saved so a re-render can reuse the path", async () => {
    const item = (await ingestGalleryAsset("GAL", asset("k.jpg", "2024-01-01T00:00:00Z"), false))!;
    const slideshow = createSlideshow(creator, "S");
    setSlideshowMovieAsset(slideshow.id, { libraryId: "GAL", relativePath: "Slideshow movies/S.mp4", itemId: item });
    const row = getSlideshow(slideshow.id)!;
    expect(row.movie_library_id).toBe("GAL");
    expect(row.movie_relative_path).toBe("Slideshow movies/S.mp4");
    expect(row.movie_item_id).toBe(item);
  });
});

describe("deleteSlideshowRender", () => {
  let thumbRoot: string;
  beforeEach(() => {
    thumbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ss-render-del-"));
    db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(thumbnailPathSettingKey, thumbRoot);
  });
  afterEach(() => { fs.rmSync(thumbRoot, { recursive: true, force: true }); });

  it("deletes the movie + leftover temp files and resets the slideshow to draft", () => {
    const slideshow = createSlideshow(creator, "S");
    const key = thumbnailStorageKey("slideshows", slideshow.id, `${slideshow.id}.mp4`);
    const finalPath = thumbnailAbsolutePath(key);
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.writeFileSync(finalPath, "movie");
    const tmpA = `${finalPath}.tmp-aaaaaa.mp4`;
    const tmpB = `${finalPath}.tmp-bbbbbb.mp4`;
    fs.writeFileSync(tmpA, "x");
    fs.writeFileSync(tmpB, "x");
    // An unrelated file in the same bucket must survive the sweep.
    const other = path.join(path.dirname(finalPath), "keep.mp4");
    fs.writeFileSync(other, "keep");
    setSlideshowRenderState(slideshow.id, { status: "ready", outputStorageKey: key, outputBytes: 5, renderedAt: new Date().toISOString() });

    deleteSlideshowRender(getSlideshow(slideshow.id)!);

    expect(fs.existsSync(finalPath)).toBe(false);
    expect(fs.existsSync(tmpA)).toBe(false);
    expect(fs.existsSync(tmpB)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
    const row = getSlideshow(slideshow.id)!;
    expect(row.render_status).toBe("draft");
    expect(row.output_storage_key).toBeNull();
    expect(row.output_bytes).toBeNull();
    expect(row.rendered_at).toBeNull();
  });

  it("sweeps temp files even when no movie was ever produced (output key null)", () => {
    const slideshow = createSlideshow(creator, "S");
    const key = thumbnailStorageKey("slideshows", slideshow.id, `${slideshow.id}.mp4`);
    const finalPath = thumbnailAbsolutePath(key);
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    const tmp = `${finalPath}.tmp-cccccc.mp4`;
    fs.writeFileSync(tmp, "x");
    // render_status draft, output_storage_key never set.

    deleteSlideshowRender(getSlideshow(slideshow.id)!);
    expect(fs.existsSync(tmp)).toBe(false);
  });
});
