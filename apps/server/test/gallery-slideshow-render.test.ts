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
  getSlideshowRenderItems,
  titleCardLines,
  closingCardLines,
  type SlideshowRow,
  type SlideshowRenderItem
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
  describeFfmpegFailure,
  parseFilterList,
  capabilitiesFrom,
  chunkSegments,
  titleCardSegment,
  titleBackgroundFor,
  musicWindows,
  TITLE_CARD_SECONDS,
  RANDOM_XFADES,
  RENDER_JOB_TYPE,
  type Segment
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

  // ffmpeg-static ships a different build per platform and they do NOT have the
  // same filters — the Linux one has no drawtext, which used to fail every render
  // on a Linux host ("Filter not found"). The title card no longer needs any filter
  // (it arrives as a picture), and what's left is probed so a missing filter costs
  // a feature rather than the movie.
  describe("what the installed ffmpeg can do", () => {
    const LISTING = [
      "Filters:",
      "  T.. = Timeline support",
      "  .S. = Slice threading",
      "  ..C = Command support",
      " ... acopy             A->A       Copy the input audio unchanged to the output.",
      " TSC afade             A->A       Fade in/out input audio.",
      " ..C drawbox           V->V       Draw a colored box on the input video.",
      " TSC drawtext          V->V       Draw text on top of video frames.",
      " ... xfade             VV->V      Cross fade one video with another video.",
      " ... color             |->V       Provide an uniformly colored input."
    ].join("\n");

    it("reads the filter names out of an ffmpeg -filters listing", () => {
      const filters = parseFilterList(LISTING);
      expect(filters.has("drawtext")).toBe(true);
      expect(filters.has("xfade")).toBe(true);
      expect(filters.has("afade")).toBe(true);
      // Header and legend lines are not filters.
      expect(filters.has("Filters:")).toBe(false);
      expect(filters.has("=")).toBe(false);
    });

    it("falls back to hard cuts when the build has no xfade", () => {
      const noXfade = parseFilterList(LISTING.split("\n").filter((l) => !l.includes("xfade")).join("\n"));
      expect(capabilitiesFrom(noXfade)).toEqual({ xfade: false });
    });

    // The card is drawn before ffmpeg runs, so a build without drawtext keeps it.
    it("keeps the title card on a build with no drawtext", () => {
      const noDrawtext = parseFilterList(LISTING.split("\n").filter((l) => !l.includes("drawtext")).join("\n"));
      expect(capabilitiesFrom(noDrawtext)).toEqual({ xfade: true });
    });

    // A probe that couldn't run tells us nothing, and "nothing" must not disable
    // features — a genuine failure still reports ffmpeg's own words.
    it("assumes a full build when the probe returns nothing", () => {
      expect(capabilitiesFrom(new Set())).toEqual({ xfade: true });
    });
  });

  // What a failed render tells the person who asked for it. Before this, every
  // failure read "check the server logs for ffmpeg output" — and nothing ever read
  // ffmpeg's stderr, so those logs held no ffmpeg output to check.
  describe("reporting a failed encode", () => {
    it("repeats ffmpeg's last line, which is where it says what broke", () => {
      const stderr = [
        "[image2 @ 0x5586] Could not open file : /photos/gone.jpg",
        "Error opening input file /photos/gone.jpg.",
        "Error opening input files: No such file or directory"
      ].join("\n");
      expect(describeFfmpegFailure(stderr, 1, null)).toBe("Error opening input files: No such file or directory");
    });

    // The failure a container hits before it can write anything: killed outright.
    it("names the memory ceiling when the encoder was killed", () => {
      expect(describeFfmpegFailure("", null, "SIGKILL")).toMatch(/memory limit/);
      expect(describeFfmpegFailure("", 137, null)).toMatch(/memory limit/);
    });

    it("still says something when ffmpeg died silently", () => {
      expect(describeFfmpegFailure("   \n  \n", 1, null)).toMatch(/exited with code 1 without saying why/);
    });

    it("truncates a runaway line rather than pasting a screenful into the dialog", () => {
      const detail = describeFfmpegFailure("x".repeat(1000), 1, null);
      expect(detail).toHaveLength(241); // 240 + the ellipsis
      expect(detail.endsWith("…")).toBe(true);
    });
  });

  it("'kenburns' renders as a crossfade (zoompan is too slow to render)", () => {
    const filter = buildFfmpegArgs(segs([4, 4]), "kenburns", null, "/o.mp4").args.join(" ");
    expect(filter).toContain("xfade=transition=fade");
    expect(filter).not.toContain("zoompan");
  });

  // Errors only: everything ffmpeg writes is captured and reported, and its default
  // per-input chatter would bury the line that matters.
  it("asks ffmpeg for errors alone, with no banner", () => {
    const { args } = buildFfmpegArgs(segs([4, 4]), "crossfade", null, "/o.mp4");
    expect(args.slice(0, 3)).toEqual(["-hide_banner", "-v", "error"]);
  });

  // This runs on somebody's NAS beside everything else that box does. Given every
  // core, a render reads as "the server fell over", because everything else on it did.
  it("holds itself to a share of the machine", () => {
    const { args } = buildFfmpegArgs(segs([4, 4]), "crossfade", null, "/o.mp4");
    const filterThreads = Number(args[args.indexOf("-filter_complex_threads") + 1]);
    // The LAST -threads is the encoder's; the earlier ones belong to the inputs.
    const encoderThreads = Number(args[args.lastIndexOf("-threads") + 1]);
    expect(filterThreads).toBeGreaterThanOrEqual(1);
    expect(filterThreads).toBeLessThanOrEqual(2);
    expect(encoderThreads).toBeGreaterThanOrEqual(1);
    expect(encoderThreads).toBeLessThanOrEqual(4);
  });

  // Where a render's memory actually goes: ffmpeg threads each input's DECODER across
  // every core by default, and every one of those threads holds frames. With an input
  // per slide that dominates everything else — measured on a six-way join, 1621 MB
  // as-is against 541 MB with one thread apiece.
  it("gives every input a single decoder thread", () => {
    const stills = buildFfmpegArgs(segs([4, 4, 4]), "crossfade", null, "/o.mp4").args.join(" ");
    expect((stills.match(/-threads 1 -loop 1 -t/g) ?? [])).toHaveLength(3); // one per slide

    const withVideo = buildFfmpegArgs(
      [{ file: "/clip.mp4", dwell: 6, isVideo: true }, ...segs([4])], "crossfade", null, "/o.mp4"
    ).args.join(" ");
    expect(withVideo).toContain("-threads 1 -t 8.000 -i /clip.mp4");
  });

  it("muxes a music input with an out-fade when a track is given", () => {
    const { args, total } = buildFfmpegArgs(segs([4, 4]), "crossfade", "/bed.flac", "/o.mp4");
    const joined = args.join(" ");
    expect(joined).toContain("-stream_loop -1 -i /bed.flac");
    // Without a closing card: the 2-second tail fade every movie has always had.
    expect(joined).toContain(`afade=t=out:st=${(total - 2).toFixed(2)}:d=2`);
    expect(joined).toContain("-c:a aac");
    expect(joined).toContain("-shortest");
  });

  // With a closing card the music fades out UNDER the credits: the fade starts
  // where the card starts, so the slides end at full volume and the movie ends
  // in silence.
  it("anchors the music fade to the closing card when one ends the movie", () => {
    const { args, total } = buildFfmpegArgs(
      segs([4, 4, 5]), "crossfade", "/bed.flac", "/o.mp4", 2, undefined, { closingDwell: 5 }
    );
    expect(args.join(" ")).toContain(`afade=t=out:st=${(total - 5).toFixed(2)}:d=5`);
  });

  it("caps the closing fade at 8 seconds — a long card doesn't need a longer fade", () => {
    const { args, total } = buildFfmpegArgs(
      segs([6, 6, 15]), "crossfade", "/bed.flac", "/o.mp4", 2, undefined, { closingDwell: 15 }
    );
    expect(args.join(" ")).toContain(`afade=t=out:st=${(total - 15).toFixed(2)}:d=8`);
  });

  it("ignores closingDwell without music — there is nothing to fade", () => {
    const { args } = buildFfmpegArgs(segs([4, 4]), "crossfade", null, "/o.mp4", 2, undefined, { closingDwell: 5 });
    expect(args.join(" ")).not.toContain("afade");
  });

  // ── A clip's own sound ────────────────────────────────────────────────────
  //
  // A sounded intro/outro clip contributes its audio and the music PAUSES under
  // it, resuming from where it left off. The soundtrack is then assembled in the
  // filtergraph instead of the straight music map.

  describe("clip sound", () => {
    it("plans the music into the gaps between clips, resuming where it paused", () => {
      // intro [0..16], outro [180..198] in a 205s movie:
      const windows = musicWindows(
        [{ file: "/i.mp4", start: 0, duration: 16 }, { file: "/o.mp4", start: 180, duration: 18 }],
        205
      );
      expect(windows).toEqual([
        { at: 16, len: 164, from: 0 },  // after the intro, from the song's top
        { at: 198, len: 7, from: 164 }  // after the outro, resuming — not restarting
      ]);
      // No clips: one window, the whole movie.
      expect(musicWindows([], 100)).toEqual([{ at: 0, len: 100, from: 0 }]);
      // A blink of a gap is dropped, not resumed into.
      expect(musicWindows([{ file: "/i.mp4", start: 0, duration: 99.9 }], 100)).toEqual([]);
    });

    it("assembles the soundtrack in the graph: clip audio delayed into place, music in the gaps", () => {
      const { args } = buildFfmpegArgs(
        segs([16, 4, 4]), "crossfade", "/bed.flac", "/o.mp4", 2, undefined,
        { clipSounds: [{ file: "/intro.mp4", start: 0, duration: 16 }] }
      );
      const joined = args.join(" ");
      // The clip rides as an extra input; its audio is trimmed to its window and
      // eased out so a cap never ends on a click.
      expect(joined).toContain("-i /intro.mp4");
      expect(joined).toContain("atrim=0:16.000");
      expect(joined).toContain("afade=t=out:st=15.500:d=0.50");
      // Music enters after the clip (delayed to 16s), from the song's top.
      expect(joined).toContain("atrim=0.000:10.000");
      expect(joined).toContain("adelay=16000:all=1");
      // One soundtrack out, no -shortest (the pieces are trimmed by construction).
      expect(joined).toContain("amix=inputs=2");
      expect(joined).toContain("-map [aout]");
      expect(joined).not.toContain("-shortest");
    });

    it("keeps the closing fade on the assembled soundtrack", () => {
      const { args, total } = buildFfmpegArgs(
        segs([16, 4, 5]), "crossfade", "/bed.flac", "/o.mp4", 2, undefined,
        { closingDwell: 5, clipSounds: [{ file: "/intro.mp4", start: 0, duration: 16 }] }
      );
      expect(args.join(" ")).toContain(`afade=t=out:st=${(total - 5).toFixed(2)}:d=5[aout]`);
    });

    it("carries clip sound alone when there is no music", () => {
      const { args } = buildFfmpegArgs(
        segs([16, 4, 4]), "crossfade", null, "/o.mp4", 2, undefined,
        { clipSounds: [{ file: "/intro.mp4", start: 0, duration: 16 }] }
      );
      const joined = args.join(" ");
      expect(joined).toContain("-i /intro.mp4");
      expect(joined).toContain("-map [aout]");
      expect(joined).not.toContain("amix"); // one piece needs no mixer
    });

    it("changes nothing when no clip carries sound", () => {
      const plain = buildFfmpegArgs(segs([4, 4]), "crossfade", "/bed.flac", "/o.mp4").args.join(" ");
      const empty = buildFfmpegArgs(segs([4, 4]), "crossfade", "/bed.flac", "/o.mp4", 2, undefined, { clipSounds: [] }).args.join(" ");
      expect(empty).toBe(plain);
      expect(plain).toContain("-shortest"); // the original straight-map path
    });
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
  // Already a picture by the time ffmpeg sees it — see gallery-slideshow-title-card
  // for how it's drawn, and why it isn't drawtext any more. It goes into the graph as
  // an ordinary still segment, which is why nothing below is a special case.
  const card = titleCardSegment("/tmp/card.png");

  it("is a still like any other, first in the chain", () => {
    const { args, total } = buildFfmpegArgs([card, ...segs([4, 4])], "crossfade", null, "/o.mp4", 2);
    const joined = args.join(" ");
    // Card input = 3s on screen + the 2s transition it hands off through.
    expect(joined).toContain("-loop 1 -t 5.000 -i /tmp/card.png");
    expect(joined).not.toContain("drawtext");
    expect(joined).not.toContain("lavfi");
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("[0:v]scale=1920:1080:force_original_aspect_ratio=decrease");
    // Card holds 3s, then a photo every 4s: transitions at 3 and 7.
    expect(filter).toContain("xfade=transition=fade:duration=2:offset=3.000");
    expect(filter).toContain("xfade=transition=fade:duration=2:offset=7.000");
    expect(total).toBe(3 + 4 + 4 + 2); // card + both dwells + one transition tail
  });

  it("shifts the music input index past the card", () => {
    const { args } = buildFfmpegArgs([card, ...segs([4, 4])], "crossfade", "/bed.flac", "/o.mp4", 2);
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
    const { args } = buildFfmpegArgs([card, ...segs([6])], "crossfade", null, "/o.mp4", 5);
    expect(args.join(" ")).toContain(`-loop 1 -t ${(TITLE_CARD_SECONDS + 5).toFixed(3)} -i /tmp/card.png`);
    // First photo starts appearing only after the card's full 3 seconds.
    expect(args[args.indexOf("-filter_complex") + 1]).toContain("offset=3.000");
  });

  it("holds for the slideshow's own title_seconds, within sane bounds", () => {
    expect(titleCardSegment("/tmp/card.png", 8).dwell).toBe(8);
    // A card can't be gone in a blink or outstay the movie, whatever is in the column.
    expect(titleCardSegment("/tmp/card.png", 0).dwell).toBe(1);
    expect(titleCardSegment("/tmp/card.png", 900).dwell).toBe(15);
    expect(titleCardSegment("/tmp/card.png", Number.NaN).dwell).toBe(TITLE_CARD_SECONDS);
  });
});

// What the card says and what it sits on, resolved from the slideshow's own settings.
// Both are pure, so the movie and the editor's preview can never disagree.
describe("title card settings", () => {
  const lines = (fields: Partial<Parameters<typeof titleCardLines>[0]>, count = 3) =>
    titleCardLines(
      { name: "Summer", title_text: null, title_subtitle_mode: "count", title_subtitle: null, ...fields },
      count
    );

  it("falls back to the slideshow's name, and counts the photos by default", () => {
    expect(lines({})).toEqual({ title: "Summer", subtitle: "3 photos" });
    expect(lines({}, 1)).toEqual({ title: "Summer", subtitle: "1 photo" });
    expect(lines({ title_text: "  " })).toEqual({ title: "Summer", subtitle: "3 photos" });
    expect(lines({ title_text: "Sicily" }).title).toBe("Sicily");
  });

  it("takes a line of its own, or none at all", () => {
    expect(lines({ title_subtitle_mode: "custom", title_subtitle: "August 2026" }).subtitle).toBe("August 2026");
    // 'custom' with nothing written in it is no subtitle, not an empty one.
    expect(lines({ title_subtitle_mode: "custom", title_subtitle: null }).subtitle).toBeNull();
    expect(lines({ title_subtitle_mode: "none" }).subtitle).toBeNull();
  });

  // The closing card: an end title plus free credit lines — no subtitle modes, and
  // a photo count would make no sense at the end.
  it("closes on “The End” unless renamed, with the credits carried as written", () => {
    expect(closingCardLines({ closing_text: null, closing_lines: null }))
      .toEqual({ title: "The End", subtitle: null });
    expect(closingCardLines({ closing_text: "  ", closing_lines: "  " }))
      .toEqual({ title: "The End", subtitle: null });
    expect(closingCardLines({ closing_text: "Конец", closing_lines: "Filmed by Dad\nMusic: our song" }))
      .toEqual({ title: "Конец", subtitle: "Filmed by Dad\nMusic: our song" });
  });

  // The background can only be built from PHOTOS the render can read: sharp reads
  // stills, and a video frame would have to be decoded first.
  describe("what the words sit on", () => {
    let root = "";
    let items: SlideshowRenderItem[] = [];
    const settings = (fields: Partial<SlideshowRow>): SlideshowRow =>
      ({ title_background: "black", title_photo_item_id: null, ...fields } as SlideshowRow);

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "title-bg-src-"));
      // The background resolver goes through the same path-safety the render does, so
      // the files have to sit inside a configured container to be reachable at all.
      db.prepare("INSERT OR REPLACE INTO storage_roots (id, name, path, created_by) VALUES ('sr-title', 'test', ?, 'creator')")
        .run(root);
      db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(thumbnailPathSettingKey, fs.mkdtempSync(path.join(os.tmpdir(), "title-bg-thumbs-")));
      for (const name of ["one.jpg", "two.jpg"]) fs.writeFileSync(path.join(root, name), "x");
      items = [
        { id: "i1", kind: "photo", relative_path: "one.jpg", source_path: root, dwell_seconds: null, duration_seconds: null, rotation: 90 },
        { id: "i2", kind: "photo", relative_path: "two.jpg", source_path: root, dwell_seconds: null, duration_seconds: null, rotation: null },
        { id: "v1", kind: "video", relative_path: "clip.mp4", source_path: root, dwell_seconds: null, duration_seconds: 8, rotation: null }
      ];
    });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    it("uses the chosen photo, carrying its rotation", () => {
      expect(titleBackgroundFor(settings({ title_background: "photo", title_photo_item_id: "i1" }), items))
        .toEqual({ kind: "photo", photo: { file: path.join(root, "one.jpg"), rotation: 90 } });
    });

    it("falls back to the first slide when the chosen photo has left the slideshow", () => {
      // Still a photo card, just not that photo — the setting says "a photo".
      expect(titleBackgroundFor(settings({ title_background: "blur", title_photo_item_id: "gone" }), items))
        .toEqual({ kind: "blur", photo: { file: path.join(root, "one.jpg"), rotation: 90 } });
    });

    it("tiles every photo for a collage, and leaves the videos out", () => {
      const background = titleBackgroundFor(settings({ title_background: "collage" }), items);
      expect(background).toEqual({
        kind: "collage",
        photos: [
          { file: path.join(root, "one.jpg"), rotation: 90 },
          { file: path.join(root, "two.jpg"), rotation: 0 }
        ]
      });
    });

    it("goes back to black when there is no photo to use", () => {
      const videosOnly = items.filter((item) => item.kind === "video");
      expect(titleBackgroundFor(settings({ title_background: "collage" }), videosOnly)).toEqual({ kind: "black" });
      expect(titleBackgroundFor(settings({ title_background: "photo" }), videosOnly)).toEqual({ kind: "black" });
      // And 'black' never opens a file at all.
      expect(titleBackgroundFor(settings({ title_background: "black" }), items)).toEqual({ kind: "black" });
    });
  });
});

// A long slideshow is rendered a dozen slides at a time and the batches joined, so
// peak memory is a property of the batch size rather than of the slideshow. That is
// only safe because the arithmetic comes out at exactly the same movie.
describe("batched rendering", () => {
  it("splits into batches and never leaves one slide stranded alone", () => {
    expect(chunkSegments(segs(new Array(24).fill(4)), 12).map((b) => b.length)).toEqual([12, 12]);
    expect(chunkSegments(segs(new Array(25).fill(4)), 12).map((b) => b.length)).toEqual([12, 13]);
    expect(chunkSegments(segs(new Array(26).fill(4)), 12).map((b) => b.length)).toEqual([12, 12, 2]);
    expect(chunkSegments(segs([4, 4]), 12).map((b) => b.length)).toEqual([2]);
  });

  // The heart of it: a batch rendered with the usual padding ends with a T-long tail
  // of its last slide, which is exactly what the next batch cross-fades over. Joining
  // them must therefore reproduce the single-pass length and transition count.
  it("adds up to the same movie a single pass would make", () => {
    const dwells = new Array(30).fill(5);
    const T = 2;
    const single = buildFfmpegArgs(segs(dwells), "crossfade", null, "/o.mp4", T);

    const batches = chunkSegments(segs(dwells), 12);
    const rendered = batches.map((batch) => buildFfmpegArgs(batch, "crossfade", null, "/b.mp4", T));
    // Each batch runs its own dwells plus one transition tail.
    for (const [i, batch] of batches.entries()) {
      expect(rendered[i].total).toBe(batch.reduce((n, s) => n + s.dwell, 0) + T);
    }

    const join = buildFfmpegArgs(
      rendered.map((r) => ({ file: "/b.mp4", dwell: r.total, isVideo: true })),
      "crossfade", null, "/o.mp4", T, undefined, { prePadded: true }
    );
    expect(join.total).toBe(single.total);

    // And the same number of cross-fades: inside the batches, plus one per seam.
    const cuts = (args: string[]) =>
      (args[args.indexOf("-filter_complex") + 1].match(/xfade=/g) ?? []).length;
    const batchCuts = rendered.reduce((n, r) => n + cuts(r.args), 0);
    expect(batchCuts + cuts(join.args)).toBe(cuts(single.args));
  });

  // Batch videos already carry the overlap in their own length; padding them again
  // would ask xfade for footage past the end of the file.
  it("doesn't pad batch videos a second time", () => {
    const joined = buildFfmpegArgs(
      [{ file: "/b0.mp4", dwell: 62, isVideo: true }, { file: "/b1.mp4", dwell: 62, isVideo: true }],
      "crossfade", null, "/o.mp4", 2, undefined, { prePadded: true }
    );
    expect(joined.args.join(" ")).toContain("-t 62.000 -i /b0.mp4");
    expect(joined.args[joined.args.indexOf("-filter_complex") + 1]).toContain("offset=60.000");
    expect(joined.total).toBe(62 + 62 - 2);
  });

  it("encodes the intermediates finer than the finished movie", () => {
    const batch = buildFfmpegArgs(segs([4, 4]), "crossfade", null, "/b.mp4", 2, undefined, { crf: 18 });
    const final = buildFfmpegArgs(segs([4, 4]), "crossfade", null, "/o.mp4", 2);
    expect(batch.args[batch.args.indexOf("-crf") + 1]).toBe("18");
    expect(final.args[final.args.indexOf("-crf") + 1]).toBe("22");
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

describe('schema baseline (3.0.0)', () => {
  // 3.0.0 folded migrations 24-31 into schema.sql, as 2.0.0 folded 2-22 before them.
  // What those migrations used to guarantee is now a property of the schema itself, so
  // that is what these test: one pass builds everything, and nothing is replayed.
  it('builds a complete schema in one pass and stamps the current version', () => {
    const scratch = new Database(':memory:');
    migrate(scratch);
    // 45 = the baseline (32) plus the title-card columns, the alphabet-index
    // columns, the slideshow cover column, the person cover column, the session
    // kind/label columns, the remote flag on a device-link request, the
    // login-attempt kind column, the reputation country/ISP columns, the person
    // website/location columns, dropping the retired empty-recycle-bin job row,
    // the title-card lettering columns, the closing-card columns, the
    // intro/outro clip columns, and the clip-sound flags — none of which a fresh
    // file needs, since schema.sql builds it complete and seeds no such job;
    // those migrations are only for databases that predate them.
    expect(scratch.pragma('user_version', { simple: true })).toBe(46);

    const userColumns = (scratch.pragma('table_info(users)') as { name: string }[]).map((c) => c.name);
    expect(userColumns).toEqual(
      expect.arrayContaining(['ereader_email', 'mfa_enabled', 'mfa_method', 'mfa_secret', 'mfa_backup_codes'])
    );
    const itemColumns = (scratch.pragma('table_info(library_items)') as { name: string }[]).map((c) => c.name);
    expect(itemColumns).toContain('scan_rule_id');
    scratch.close();
  });

  // Everything the folded migrations added, in one place: if any of it went missing
  // from schema.sql during the fold, a fresh install would be short a column with no
  // migration left to add it back.
  it('carries every column the folded migrations used to add', () => {
    const scratch = new Database(':memory:');
    migrate(scratch);
    const columns = (table: string) =>
      (scratch.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);

    expect(columns('users')).toContain('mfa_method');
    expect(columns('mfa_challenges')).toEqual(
      expect.arrayContaining(['purpose', 'code_hash', 'sends', 'last_sent_at'])
    );
    expect(columns('gallery_details')).toEqual(expect.arrayContaining(['content_hash', 'content_hash_at']));
    expect(columns('trashed_items')).toEqual(
      expect.arrayContaining(['cover_key', 'source', 'expires_at', 'trash_root'])
    );
    expect(columns('duplicate_job_result_members')).toContain('distance');
    expect(columns('duplicate_job_results')).toEqual(expect.arrayContaining(['match_confidence', 'keeper_rank']));

    // The partial index over content_hash lived in migration 25 because schema.sql runs
    // first and the column did not exist yet on an upgrade. With no upgrades it belongs
    // in schema.sql — and has to actually be there.
    const index = scratch.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_gallery_content_hash'"
    ).get();
    expect(index).toBeTruthy();
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

  // The whole upgrade path is one sentence now: 3.0.0 is a new install. A 2.x database
  // is refused rather than half-migrated, and the message has to say what to do about
  // it — including the one thing that cannot be rebuilt by rescanning.
  it('refuses a 2.x database instead of upgrading it', () => {
    const stale = new Database(':memory:');
    migrate(stale);
    stale.pragma('user_version = 26'); // a 2.22.0 install
    expect(() => migrate(stale)).toThrow(/new install rather than an upgrade/);
    expect(() => migrate(stale)).toThrow(/GEDCOM/);
    stale.close();
  });

  it('adopts the last 2.x schema, which is already identical to a fresh one', () => {
    const current = new Database(':memory:');
    migrate(current);
    current.pragma('user_version = 31'); // every 2.x migration applied
    expect(() => migrate(current)).not.toThrow();
    expect(current.pragma('user_version', { simple: true })).toBe(46);
    current.close();
  });

  // Migration 33 (title cards) is the first change to a RELEASED 3.x schema: new
  // columns on a table an existing database already has, which schema.sql alone can
  // never reach. This builds that older table by hand and checks the ALTERs land.
  it('adds the title-card columns to a database that predates them', () => {
    const old = new Database(':memory:');
    old.exec('CREATE TABLE gallery_slideshows (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL)');
    old.prepare('INSERT INTO gallery_slideshows (id, name, created_by) VALUES (?, ?, ?)').run('s1', 'Holiday', 'u1');

    migrate(old);

    const columns = (old.pragma('table_info(gallery_slideshows)') as { name: string }[]).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining([
      'title_enabled', 'title_text', 'title_subtitle_mode', 'title_subtitle',
      'title_seconds', 'title_background', 'title_photo_item_id', 'cover_item_id'
    ]));
    // The defaults are the card 3.1.x drew, so a slideshow made before this existed
    // re-renders the same movie until someone changes something.
    expect(old.prepare('SELECT * FROM gallery_slideshows WHERE id = ?').get('s1')).toMatchObject({
      title_enabled: 1, title_text: null, title_subtitle_mode: 'count',
      title_seconds: 3, title_background: 'black', title_photo_item_id: null
    });
    // Idempotent: a second pass must not try to add columns that are already there.
    expect(() => migrate(old)).not.toThrow();
    old.close();
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
