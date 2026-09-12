import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});
// Leaflet needs a real layout engine; the cover banner's picker needs the gallery.
// Neither has anything to do with the drafts under test.
vi.mock("../src/features/stories/StoryMap", () => ({ StoryMap: () => <div /> }));
vi.mock("../src/features/stories/StoryMapModal", () => ({ StoryMapModal: () => <div /> }));
vi.mock("../src/features/gallery/PhotoPicker", () => ({ PhotoPicker: () => <div /> }));

const { api } = await import("../src/api");
const { StoryChapterEditor } = await import("../src/features/stories/StoryChapterEditor");
const { StoryOverviewPane } = await import("../src/features/stories/StoryOverviewPane");
const { StoryBlockEditor } = await import("../src/features/stories/StoryBlockEditor");
import type { StoryBlock, StoryChapter, StoryDetail } from "../src/features/stories/types";

// Every patch in the story editor re-reads the WHOLE story, so a chapter or story
// object with new field values arriving while something is being typed is the
// normal case. StoryEditorPage renders both of these panes keyed on the subject's
// id, so each is remounted for another chapter/story and left alone otherwise —
// they used to re-seed their drafts from effects on the subject's own fields, and a
// reload landing between two keystrokes put the stored text back in the box.

function chapter(over: Partial<StoryChapter> = {}): StoryChapter {
  return {
    id: "c1", position: 0, title: "Arrival", date: "1974-06", endDate: null, dateApprox: false,
    place: "Duluth", placeLat: null, placeLng: null, description: "", standfirst: null,
    heroItemId: null, hero: null, heroMap: false, blocks: [],
    ...over
  };
}

function story(over: Partial<StoryDetail> = {}): StoryDetail {
  return {
    id: "s1", title: "One summer", subtitle: null, status: "draft", coverItemId: null, cover: null,
    coverUrl: null, canEdit: true, createdAt: "2020-01-01", updatedAt: "2020-01-01",
    previewLimit: 4, tags: [], chapterNoun: "Day", intro: null, rating: null, servings: null,
    cookMinutes: null, authorName: "Mum", saved: false, collectionId: null, collection: null,
    kind: "memory", chapters: [chapter()],
    ...over
  };
}

beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue({ bylines: [], tags: [], collections: [] } as never);
});

describe("StoryChapterEditor settings drafts", () => {
  function Harness({ second }: { second: StoryChapter }) {
    const [current, setCurrent] = useState(chapter());
    const [tick, setTick] = useState(0);
    const blockActions = {
      move: vi.fn(), moveToChapter: vi.fn(), reorder: vi.fn(), patch: vi.fn(), remove: vi.fn()
    };
    return (
      <>
        <StoryChapterEditor
          key={current.id}
          story={story({ chapters: [current] })}
          chapter={current}
          index={0}
          busy={false}
          onPatch={() => {}}
          onRemove={() => {}}
          onAddBlocks={() => {}}
          blockActions={blockActions}
        />
        {/* The story re-read: same chapter, the server's stored values. */}
        <button type="button" onClick={() => setCurrent(chapter({ place: "Duluth" }))}>reload</button>
        {/* Another chapter opened — the pane is keyed on the id, so it remounts. */}
        <button type="button" onClick={() => setCurrent(second)}>other chapter</button>
        <button type="button" onClick={() => setTick(tick + 1)}>re-render {tick}</button>
      </>
    );
  }

  // The settings card folds itself away for a chapter that already has a date and
  // a place, so every test opens it first.
  const openSettings = () => userEvent.click(screen.getByRole("button", { name: /Chapter settings/ }));
  const placeField = () => screen.getByLabelText("Place") as HTMLInputElement;

  it("keeps a half-typed place when the story is re-read underneath", async () => {
    render(<Harness second={chapter({ id: "c2", place: "Two Harbors" })} />);
    await openSettings();
    await userEvent.clear(placeField());
    await userEvent.type(placeField(), "Duluth, Minnesota");
    fireEvent.click(screen.getByRole("button", { name: "reload" }));
    expect(placeField()).toHaveValue("Duluth, Minnesota");
  });

  it("does not reset the drafts on an unrelated re-render", async () => {
    render(<Harness second={chapter({ id: "c2", place: "Two Harbors" })} />);
    await openSettings();
    await userEvent.type(placeField(), ", Minnesota");
    fireEvent.click(screen.getByRole("button", { name: /re-render/ }));
    expect(placeField()).toHaveValue("Duluth, Minnesota");
  });

  it("re-seeds for another chapter, because the page keys it on the chapter id", async () => {
    render(<Harness second={chapter({ id: "c2", place: "Two Harbors" })} />);
    await openSettings();
    await userEvent.type(placeField(), ", Minnesota");
    fireEvent.click(screen.getByRole("button", { name: "other chapter" }));
    // Remounted: even the settings card is back to how it opens for that chapter.
    expect(screen.queryByLabelText("Place")).toBeNull();
    await openSettings();
    expect(placeField()).toHaveValue("Two Harbors");
  });
});

describe("StoryOverviewPane drafts", () => {
  function Harness({ second }: { second: StoryDetail }) {
    const [current, setCurrent] = useState(story());
    const [tick, setTick] = useState(0);
    return (
      <>
        <StoryOverviewPane key={current.id} story={current} busy={false} onPatch={() => {}} onTags={() => {}} />
        <button type="button" onClick={() => setCurrent(story({ updatedAt: "later" }))}>reload</button>
        <button type="button" onClick={() => setCurrent(second)}>other story</button>
        <button type="button" onClick={() => setTick(tick + 1)}>re-render {tick}</button>
      </>
    );
  }

  const openSettings = () => userEvent.click(screen.getByRole("button", { name: /Story details/ }));
  const bylineField = () => screen.getByLabelText("Written by") as HTMLInputElement;

  it("keeps a half-typed byline when the story is re-read underneath", async () => {
    render(<Harness second={story({ id: "s2", authorName: "Dad" })} />);
    await openSettings();
    await userEvent.clear(bylineField());
    await userEvent.type(bylineField(), "Mum and Dad");
    fireEvent.click(screen.getByRole("button", { name: "reload" }));
    expect(bylineField()).toHaveValue("Mum and Dad");
  });

  it("does not reset the drafts on an unrelated re-render", async () => {
    render(<Harness second={story({ id: "s2", authorName: "Dad" })} />);
    await openSettings();
    await userEvent.type(bylineField(), " and Dad");
    fireEvent.click(screen.getByRole("button", { name: /re-render/ }));
    expect(bylineField()).toHaveValue("Mum and Dad");
  });

  it("re-seeds for another story, because the page keys it on the story id", async () => {
    render(<Harness second={story({ id: "s2", authorName: "Dad" })} />);
    await openSettings();
    await userEvent.type(bylineField(), " and Dad");
    fireEvent.click(screen.getByRole("button", { name: "other story" }));
    expect(screen.queryByLabelText("Written by")).toBeNull();
    await openSettings();
    expect(bylineField()).toHaveValue("Dad");
  });
});

describe("StoryBlockEditor prose draft", () => {
  function block(over: Partial<StoryBlock> = {}): StoryBlock {
    return {
      id: "bl1", chapterId: "c1", position: 0, kind: "text", entityType: null, entityId: null,
      body: "We drove up on the Friday.", heading: null, lat: null, lng: null, zoom: null,
      label: null, points: [], caption: null, layout: null, available: true, title: null,
      subtitle: null, coverUrl: null, itemCount: 0, href: null, asset: null, preview: [],
      audio: null,
      ...over
    };
  }

  function Harness({ second }: { second: StoryBlock }) {
    const [current, setCurrent] = useState(block());
    const [tick, setTick] = useState(0);
    return (
      <>
        {/* StoryChapterEditor renders each card in a slot keyed on the block id. */}
        <div key={current.id}>
          <StoryBlockEditor
            block={current}
            storyId="s1"
            storyTags={[]}
            first
            last
            busy={false}
            siblings={[]}
            onMove={() => {}}
            onMoveToChapter={() => {}}
            onPatch={() => {}}
            onRemove={() => {}}
            onDragStart={() => {}}
            onDragOver={() => {}}
            onDrop={() => {}}
            dragging={false}
          />
        </div>
        <button type="button" onClick={() => setCurrent(block({ position: 1 }))}>reload</button>
        <button type="button" onClick={() => setCurrent(second)}>other block</button>
        <button type="button" onClick={() => setTick(tick + 1)}>re-render {tick}</button>
      </>
    );
  }

  // The prose itself is the control — pressing it turns the paragraph into a field.
  const write = () => userEvent.click(document.querySelector(".story-edit-block-prose") as HTMLElement);
  const prose = () => screen.getByLabelText("Text") as HTMLTextAreaElement;

  it("keeps a half-typed paragraph when the story is re-read underneath", async () => {
    render(<Harness second={block({ id: "bl2", body: "On the Sunday we left." })} />);
    await write();
    await userEvent.type(prose(), " It rained.");
    fireEvent.click(screen.getByRole("button", { name: "reload" }));
    expect(prose()).toHaveValue("We drove up on the Friday. It rained.");
  });

  it("does not reset the draft on an unrelated re-render", async () => {
    render(<Harness second={block({ id: "bl2", body: "On the Sunday we left." })} />);
    await write();
    await userEvent.type(prose(), " It rained.");
    fireEvent.click(screen.getByRole("button", { name: /re-render/ }));
    expect(prose()).toHaveValue("We drove up on the Friday. It rained.");
  });

  it("re-seeds for another block, because the slot is keyed on the block id", async () => {
    render(<Harness second={block({ id: "bl2", body: "On the Sunday we left." })} />);
    await write();
    await userEvent.type(prose(), " It rained.");
    fireEvent.click(screen.getByRole("button", { name: "other block" }));
    await write();
    expect(prose()).toHaveValue("On the Sunday we left.");
  });
});
