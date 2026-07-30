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

describe('schema baseline (2.0.0)', () => {
  // 2.0.0 folded migrations 2-22 into schema.sql. What those migrations used to
  // guarantee is now a property of the schema itself, so that is what we test:
  // a database built in one pass accepts every value the rebuilds widened to.
  it('builds a complete schema in one pass and stamps the baseline', () => {
    const scratch = new Database(':memory:');
    migrate(scratch);
    expect(scratch.pragma('user_version', { simple: true })).toBe(23);

    const userColumns = (scratch.pragma('table_info(users)') as { name: string }[]).map((c) => c.name);
    expect(userColumns).toEqual(expect.arrayContaining(['ereader_email', 'mfa_enabled', 'mfa_secret', 'mfa_backup_codes']));
    const itemColumns = (scratch.pragma('table_info(library_items)') as { name: string }[]).map((c) => c.name);
    expect(itemColumns).toContain('scan_rule_id');
    scratch.close();
  });

  it('accepts the transition and event values the old rebuilds widened to', () => {
    const scratch = new Database(':memory:');
    migrate(scratch);
    scratch.prepare("INSERT INTO users (id, email, password_hash, display_name, role) VALUES ('u1', 'u@x', 'x', 'u', 'member')").run();
    for (const transition of ['random', 'dipblack']) {
      scratch.prepare('INSERT INTO gallery_slideshows (id, name, transition, created_by) VALUES (?, ?, ?, ?)')
        .run(transition, 'S', transition, 'u1');
    }
    expect(scratch.prepare('SELECT COUNT(*) AS n FROM gallery_slideshows').get()).toEqual({ n: 2 });

    scratch.prepare("INSERT INTO family_tree_persons (id, name, gender) VALUES ('p1', 'P', 'unknown')").run();
    for (const type of ['travel', 'award', 'graduation', 'retirement', 'naturalization', 'baptism']) {
      scratch.prepare('INSERT INTO family_tree_events (id, person_id, type) VALUES (?, ?, ?)').run(type, 'p1', type);
    }
    expect(scratch.prepare('SELECT COUNT(*) AS n FROM family_tree_events').get()).toEqual({ n: 6 });
    scratch.close();
  });

  it('adopts a fully-migrated 1.x database but refuses an older one', () => {
    const current = new Database(':memory:');
    migrate(current);
    current.pragma('user_version = 22'); // the last 1.x schema — already complete
    expect(() => migrate(current)).not.toThrow();
    expect(current.pragma('user_version', { simple: true })).toBe(23);
    current.close();

    // Older databases still needed steps that no longer exist: stop, don't stamp.
    const stale = new Database(':memory:');
    migrate(stale);
    stale.pragma('user_version = 12');
    expect(() => migrate(stale)).toThrow(/older version/);
    stale.close();
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
