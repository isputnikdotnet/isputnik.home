import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GalleryAsset } from "../src/features/gallery/types";
import type { StoryChapter, StoryDetail } from "../src/features/stories/types";

// The cover banner's picker needs the gallery; nothing here does.
vi.mock("../src/features/gallery/PhotoPicker", () => ({ PhotoPicker: () => <div /> }));
vi.mock("../src/features/stories/StoryMap", () => ({ StoryMap: () => <div /> }));

const { StoryCoverBanner } = await import("../src/features/stories/StoryCoverBanner");
const { storyPhotos } = await import("../src/features/stories/story-photos");

// A cover can come from the photos the story already shows, not only from the
// whole library: the menu offers them (greyed when there are none), the chooser
// lists each once with the current one marked, and a pick hands the asset back.

const photo = (id: string, title: string, kind: GalleryAsset["kind"] = "photo") =>
  ({ id, title, kind, coverUrl: `/thumbs/${id}.jpg` }) as unknown as GalleryAsset;

function chapter(id: string, over: Partial<StoryChapter> = {}): StoryChapter {
  return {
    id, position: 0, title: null, date: null, endDate: null, dateApprox: false, place: null,
    placeLat: null, placeLng: null, description: null, standfirst: null,
    heroItemId: null, hero: null, heroMap: false, blocks: [], ...over
  };
}
const block = (id: string, over: Record<string, unknown>) =>
  ({ id, kind: "media", asset: null, items: [], preview: [], ...over }) as unknown as StoryChapter["blocks"][number];

describe("StoryCoverBanner — photos already in the story", () => {
  it("lists the story's photos once each, this chapter's first, skipping audio", () => {
    const story = {
      chapters: [
        chapter("c1", { position: 0, blocks: [block("b1", { asset: photo("p1", "Porch") })] }),
        chapter("c2", {
          position: 1,
          hero: photo("p2", "Lake"),
          blocks: [
            block("b2", { items: [photo("p3", "Dock"), photo("p1", "Porch")] }),
            block("b3", { preview: [photo("p4", "Trail")] }),
            block("b4", { asset: photo("a1", "Narration", "audio") })
          ]
        })
      ]
    } as unknown as StoryDetail;
    expect(storyPhotos(story).map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(storyPhotos(story, "c2").map((p) => p.id)).toEqual(["p2", "p3", "p1", "p4"]);
  });

  it("offers the chooser from the cover menu and hands back the picked photo", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(
      <StoryCoverBanner
        coverUrl={null}
        pickerTitle="Chapter cover photo"
        candidates={[photo("p1", "Porch"), photo("p2", "Lake")]}
        currentId="p2"
        onPick={onPick}
        onClear={() => {}}
      />
    );
    await user.click(screen.getByRole("button", { name: "Add cover" }));
    await user.click(screen.getByRole("menuitem", { name: "Choose from this story's photos" }));

    const dialog = screen.getByRole("dialog", { name: "Photos in this story" });
    const lake = within(dialog).getByRole("button", { name: "Lake" });
    expect(lake).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByRole("button", { name: "Porch" })).toHaveAttribute("aria-pressed", "false");

    await user.click(within(dialog).getByRole("button", { name: "Porch" }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("greys the option out when the story has no photos yet", async () => {
    const user = userEvent.setup();
    render(
      <StoryCoverBanner coverUrl={null} pickerTitle="Chapter cover photo" candidates={[]} onPick={() => {}} onClear={() => {}} />
    );
    await user.click(screen.getByRole("button", { name: "Add cover" }));
    const item = screen.getByRole("menuitem", { name: "Choose from this story's photos" });
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute("title", "No photos in this story yet");
  });
});
