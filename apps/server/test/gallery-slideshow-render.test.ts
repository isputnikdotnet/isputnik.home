import { beforeEach, describe, expect, it } from "vitest";
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
  getSlideshowRenderItems
} from "../src/modules/library/gallery/slideshows.js";
import {
  buildFfmpegArgs,
  segmentsFor,
  enqueueSlideshowRender,
  renderProgressPercent,
  RENDER_JOB_TYPE,
  type Segment
} from "../src/modules/library/gallery/slideshow-render.js";
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

  it("crossfade overlaps slides, shortening total by (N-1)·transition", () => {
    const { args, total } = buildFfmpegArgs(segs([4, 4, 4]), "crossfade", null, "/out.mp4");
    expect(total).toBe(4 + 4 + 4 - 2 * 1); // two 1s transitions
    const filter = args[args.indexOf("-filter_complex") + 1];
    // offsets accumulate: first at dwell0 - T = 3, second at (4 + 4 - 1) - 1 = 6
    expect(filter).toContain("xfade=transition=fade:duration=1:offset=3.000");
    expect(filter).toContain("xfade=transition=fade:duration=1:offset=6.000");
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

  it("clamps a photo's dwell to at least the transition length and at most 30s", () => {
    const built = segmentsFor([
      { id: "a", kind: "photo", relative_path: "a.jpg", source_path: "/s", dwell_seconds: 0.2, duration_seconds: null },
      { id: "b", kind: "photo", relative_path: "b.jpg", source_path: "/s", dwell_seconds: 99, duration_seconds: null },
      { id: "c", kind: "photo", relative_path: "c.jpg", source_path: "/s", dwell_seconds: null, duration_seconds: null }
    ], 5);
    expect(built.map((s) => s.dwell)).toEqual([1.5, 30, 5]); // floored / capped / slide default
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
    expect(joined).toContain("-loop 1 -t 4.000 -i /a.jpg");
    expect(joined).toContain("-t 6.000 -i /v.mp4");
    expect(joined).not.toContain("-loop 1 -t 6.000 -i /v.mp4");
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

  it("reads a live encode percentage from the job payload", () => {
    const slideshow = createSlideshow(creator, "S");
    const jobId = enqueueSlideshowRender(slideshow, "creator");
    db.prepare("UPDATE jobs SET payload = ? WHERE id = ?")
      .run(JSON.stringify({ progress: { processed: 30, total: 120 } }), jobId);
    expect(renderProgressPercent(jobId)).toBe(25);
    expect(renderProgressPercent(null)).toBeNull();
  });

  it("a settings edit or a reorder knocks a ready render back to draft", async () => {
    const a = (await ingestGalleryAsset("GAL", asset("a.jpg", "2024-01-01T00:00:00Z"), false))!;
    const b = (await ingestGalleryAsset("GAL", asset("b.jpg", "2024-01-02T00:00:00Z"), false))!;
    const slideshow = createSlideshow(creator, "S");
    addSlideshowItems(slideshow.id, new Set(["GAL"]), [a, b]);

    setSlideshowRenderState(slideshow.id, { status: "ready", outputStorageKey: "slideshows/x/y.mp4", outputBytes: 100 });
    updateSlideshow(slideshow.id, { slideSeconds: 6 });
    expect(getSlideshow(slideshow.id)!.render_status).toBe("draft");

    setSlideshowRenderState(slideshow.id, { status: "ready" });
    reorderSlideshowItems(slideshow.id, [b, a]);
    expect(getSlideshow(slideshow.id)!.render_status).toBe("draft");
  });
});
