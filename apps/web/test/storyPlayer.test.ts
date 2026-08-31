import { describe, expect, it } from "vitest";
import {
  slidesFromStory,
  slidesFromShare,
  slideSeconds,
  waitsForMedia,
  DEFAULT_PHOTO_SECONDS,
  type PlayerSlide
} from "../src/features/stories/story-player";
import type { StoryBlock, StoryChapter, StoryDetail } from "../src/features/stories/types";
import type { GalleryAsset } from "../src/features/gallery/types";
import type { StorySharePayload } from "../src/pages/StoryShareView";

// The player is a sequencer: these hold the flattening, because that is where
// "what the room actually sees" is decided.

function asset(id: string, over: Partial<GalleryAsset> = {}): GalleryAsset {
  return {
    id,
    libraryId: "GAL",
    libraryName: "Gallery",
    folderPath: `${id}.jpg`,
    folder: "",
    kind: "photo",
    title: id,
    description: null,
    takenAt: null,
    addedAt: "2024-01-01",
    width: 100,
    height: 100,
    orientation: null,
    rotation: 0,
    durationSeconds: null,
    playable: null,
    mimeType: "image/jpeg",
    size: 1,
    gps: null,
    camera: null,
    coverUrl: `/cover/${id}`,
    previewUrl: `/preview/${id}`,
    fileUrl: `/file/${id}`,
    playbackUrl: `/play/${id}`,
    tags: [],
    saved: false,
    faceFocus: null,
    ...over
  };
}

function block(over: Partial<StoryBlock> & Pick<StoryBlock, "id" | "kind">): StoryBlock {
  return {
    chapterId: "c1",
    position: 1,
    entityType: null,
    entityId: null,
    body: null,
    lat: null,
    lng: null,
    zoom: null,
    label: null,
    caption: null,
    layout: null,
    available: true,
    title: null,
    subtitle: null,
    coverUrl: null,
    itemCount: 0,
    href: null,
    asset: null,
    preview: [],
    audio: null,
    ...over
  };
}

function chapter(over: Partial<StoryChapter> = {}): StoryChapter {
  return {
    id: "c1",
    position: 1,
    title: null,
    date: null,
    endDate: null,
    dateApprox: false,
    place: null,
    placeLat: null,
    placeLng: null,
    description: null,
    blocks: [],
    ...over
  };
}

function story(chapters: StoryChapter[]): StoryDetail {
  return {
    id: "s1",
    title: "Minnesota",
    subtitle: null,
    status: "published",
    coverItemId: null,
    canEdit: true,
    createdAt: "2024-01-01",
    updatedAt: "2024-01-01",
    previewLimit: 6,
    tags: [],
    chapters
  };
}

describe("flattening a story into slides", () => {
  it("gives a chapter an opening card only when it says something", () => {
    const bare = slidesFromStory(story([chapter({ blocks: [block({ id: "b1", kind: "text", body: "hi" })] })]));
    expect(bare.map((slide) => slide.kind)).toEqual(["text"]);

    const titled = slidesFromStory(story([
      chapter({ title: "The drive north", blocks: [block({ id: "b1", kind: "text", body: "hi" })] })
    ]));
    expect(titled.map((slide) => slide.kind)).toEqual(["chapter", "text"]);

    // A date alone is enough to be worth a card.
    const dated = slidesFromStory(story([chapter({ date: "2004" })]));
    expect(dated.map((slide) => slide.kind)).toEqual(["chapter"]);
  });

  it("plays an album through, one slide per photo", () => {
    const slides = slidesFromStory(story([
      chapter({
        blocks: [block({
          id: "album1", kind: "album", entityId: "a1",
          preview: [asset("p1"), asset("p2")]
        })]
      })
    ]));
    expect(slides).toHaveLength(2);
    expect(slides.map((slide) => slide.id)).toEqual(["album1-0", "album1-1"]);
  });

  it("prefers the fetched full album over the page's preview strip", () => {
    const chapters = [chapter({
      blocks: [block({ id: "album1", kind: "album", entityId: "a1", preview: [asset("p1")] })]
    })];
    const expansions = new Map([["album1", [asset("p1"), asset("p2"), asset("p3")]]]);
    expect(slidesFromStory(story(chapters), expansions)).toHaveLength(3);
    // …and falls back to the preview when the fetch didn't happen.
    expect(slidesFromStory(story(chapters))).toHaveLength(1);
  });

  it("skips a block whose content the viewer can't reach", () => {
    const slides = slidesFromStory(story([
      chapter({
        blocks: [
          block({ id: "b1", kind: "media", available: false, asset: asset("gone") }),
          block({ id: "b2", kind: "text", body: "still here" })
        ]
      })
    ]));
    expect(slides.map((slide) => slide.kind)).toEqual(["text"]);
  });

  it("skips an empty text block rather than showing a blank slide", () => {
    const slides = slidesFromStory(story([
      chapter({ blocks: [block({ id: "b1", kind: "text", body: "   " })] })
    ]));
    expect(slides).toHaveLength(0);
  });

  it("plays a video from its playback URL, and a photo from its preview", () => {
    const slides = slidesFromStory(story([
      chapter({
        blocks: [
          block({ id: "v", kind: "media", asset: asset("clip", { kind: "video", durationSeconds: 30 }) }),
          block({ id: "p", kind: "media", asset: asset("shot") })
        ]
      })
    ])) as Extract<PlayerSlide, { kind: "media" }>[];
    expect(slides[0]).toMatchObject({ isVideo: true, src: "/play/clip" });
    expect(slides[1]).toMatchObject({ isVideo: false, src: "/preview/shot" });
  });
});

describe("flattening a shared story", () => {
  const payload = (blocks: StorySharePayload["story"]["chapters"][number]["blocks"]): StorySharePayload => ({
    type: "story",
    share: { label: null, expiresAt: "2030-01-01", sharedBy: "Author" },
    story: {
      title: "Minnesota",
      subtitle: null,
      expandAlbums: false,
      chapters: [{ title: null, date: null, endDate: null, dateApprox: false, place: null, description: null, blocks }]
    }
  });

  const shareAsset = (id: string, kind: "photo" | "video" = "photo") => ({
    id, title: id, kind, width: null, height: null, durationSeconds: null,
    coverUrl: `/c/${id}`, previewUrl: `/p/${id}`, fileUrl: `/f/${id}`, downloadUrl: `/d/${id}`
  });

  it("plays only what the link exposed, so expandAlbums carries into the show", () => {
    // The server already trimmed the album to the link's reach; the player
    // shows exactly that, with no second decision to get wrong.
    const slides = slidesFromShare(payload([
      { kind: "album", title: "Trip", caption: null, itemCount: 40, items: [shareAsset("p1"), shareAsset("p2")] }
    ]));
    expect(slides).toHaveLength(2);
  });

  it("carries narration through to a guest's show", () => {
    const slides = slidesFromShare(payload([
      { kind: "audio", title: "Grandma tells it", durationSeconds: 40, url: "/api/share/t/audio/a1", caption: null }
    ]));
    expect(slides[0]).toMatchObject({ kind: "audio", title: "Grandma tells it", src: "/api/share/t/audio/a1" });
  });

  it("builds the same slide kinds as the signed-in page", () => {
    const slides = slidesFromShare(payload([
      { kind: "text", body: "prose" },
      { kind: "media", caption: null, layout: null, asset: shareAsset("p1") },
      { kind: "map", lat: 1, lng: 2, zoom: null, label: "Duluth", caption: null },
      { kind: "person", name: "Anna", birthDate: "1928", deathDate: "2024", caption: null },
      { kind: "quote", text: "said it", attribution: "Gorky", caption: null }
    ]));
    expect(slides.map((slide) => slide.kind)).toEqual(["text", "media", "map", "person", "quote"]);
    expect(slides[3]).toMatchObject({ kind: "person", years: "1928 – 2024" });
  });
});

describe("how long a slide holds", () => {
  it("gives prose time to be read, within bounds", () => {
    const short = slideSeconds({ id: "a", kind: "text", body: "Two words" });
    const long = slideSeconds({ id: "b", kind: "text", body: "word ".repeat(400) });
    expect(short).toBe(5);          // floored, so a one-liner doesn't blink past
    expect(long).toBe(24);          // capped, so a long passage doesn't strand the room
    expect(slideSeconds({ id: "c", kind: "text", body: "word ".repeat(30) })).toBe(10);
  });

  it("uses the caller's photo pace", () => {
    const photo: PlayerSlide = {
      id: "p", kind: "media", title: "p", src: "/p", poster: null,
      isVideo: false, caption: null, durationSeconds: null
    };
    expect(slideSeconds(photo)).toBe(DEFAULT_PHOTO_SECONDS);
    expect(slideSeconds(photo, 12)).toBe(12);
  });

  it("gives narration the stage for as long as it runs", () => {
    // A clip and a video are the same problem: something with its own runtime.
    // The seconds are only a fallback for when the element never loads.
    const clip: PlayerSlide = { id: "a", kind: "audio", title: "Grandma", src: "/a", durationSeconds: 92 };
    expect(waitsForMedia(clip)).toBe(true);
    expect(slideSeconds(clip)).toBe(92);
    expect(slideSeconds({ id: "b", kind: "audio", title: "", src: "/b", durationSeconds: null })).toBe(5);
  });

  it("hands a video its own timing instead of a clock", () => {
    const video: PlayerSlide = {
      id: "v", kind: "media", title: "v", src: "/v", poster: null,
      isVideo: true, caption: null, durationSeconds: 90
    };
    expect(waitsForMedia(video)).toBe(true);
    expect(waitsForMedia({ id: "t", kind: "text", body: "x" })).toBe(false);
  });
});
