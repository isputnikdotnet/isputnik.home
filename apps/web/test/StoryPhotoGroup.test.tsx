import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoryPhotoGroup, type PlatePhoto } from "../src/features/stories/StoryPhotoGroup";
import { groupLayout, packMosaicRows, photoAspect } from "../src/features/stories/story-layout";

// A photo group is one block drawn three ways. What matters is that the author's
// choice is honoured, that the plate never reorders or drops photos behind their
// back, and that a click anywhere on it opens the lightbox at the right place.

function photo(over: Partial<PlatePhoto> & { id: string }): PlatePhoto {
  return {
    title: `photo ${over.id}`,
    previewUrl: `/preview/${over.id}`,
    coverUrl: `/cover/${over.id}`,
    width: 3000,
    height: 2000,
    blockCaption: null,
    ...over
  };
}

const landscape = (id: string) => photo({ id, width: 3000, height: 2000 });
const portrait = (id: string) => photo({ id, width: 2000, height: 3000 });

describe("photoAspect", () => {
  it("is width over height", () => {
    expect(photoAspect({ width: 3000, height: 2000 })).toBeCloseTo(1.5);
    expect(photoAspect({ width: 2000, height: 3000 })).toBeCloseTo(0.667, 2);
  });

  it("falls back to 3:2 when a photo was never measured", () => {
    expect(photoAspect({ width: null, height: null })).toBeCloseTo(1.5);
    expect(photoAspect({ width: 3000, height: null })).toBeCloseTo(1.5);
  });

  it("clamps a panorama and a strip, so neither flattens a whole row", () => {
    expect(photoAspect({ width: 12000, height: 1000 })).toBe(3);
    expect(photoAspect({ width: 500, height: 4000 })).toBe(0.4);
  });
});

describe("packMosaicRows", () => {
  it("keeps every photo, exactly once, in order", () => {
    const photos = ["a", "b", "c", "d", "e", "f", "g"].map(landscape);
    const flat = packMosaicRows(photos).flatMap((row) => row.photos.map((cell) => cell.photo.id));
    expect(flat).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });

  it("fits more portraits on a row than landscapes, since a row is a width", () => {
    // 1.5 each: two make 3.0, past the 2.6 target — so two to a row.
    expect(packMosaicRows([landscape("a"), landscape("b"), landscape("c"), landscape("d")])
      .map((row) => row.photos.length)).toEqual([2, 2]);
    // 0.667 each: four make 2.67 — so four to a row.
    expect(packMosaicRows(["a", "b", "c", "d"].map(portrait))
      .map((row) => row.photos.length)).toEqual([4]);
  });

  it("gives each photo a share of a full row equal to its own shape", () => {
    // Two landscapes sum to 3.0, past the target, so row one is filled — and a
    // filled row's box IS the sum, which is what makes it span the measure with
    // every photo still at its own shape.
    const [row] = packMosaicRows([landscape("a"), landscape("b")]);
    expect(row.filled).toBe(true);
    expect(row.photos.map((cell) => cell.grow)).toEqual([1.5, 1.5]);
    expect(row.aspect).toBeCloseTo(3);
  });

  it("folds a stranded portrait into the row above instead of leaving it alone", () => {
    // The two landscapes fill row one; one portrait (0.667) left over would sit
    // at a quarter of the width on a line of its own, so it joins them.
    const rows = packMosaicRows([landscape("a"), landscape("b"), portrait("c")]);
    expect(rows).toHaveLength(1);
    expect(rows[0].photos.map((cell) => cell.photo.id)).toEqual(["a", "b", "c"]);
    expect(rows[0].aspect).toBeCloseTo(3.667, 2);
  });

  it("leaves a last row that can stand on its own short rather than stretching it", () => {
    // Three landscapes: two fill row one, and the third is wide enough to hold
    // a line by itself — so it keeps the target height and the row ends early,
    // rather than the photo being blown up to tidy the edge.
    const rows = packMosaicRows([landscape("a"), landscape("b"), landscape("c")]);
    expect(rows).toHaveLength(2);
    expect(rows[1].filled).toBe(false);
    expect(rows[1].aspect).toBeCloseTo(2.6);
    expect(rows[1].photos.map((cell) => cell.photo.id)).toEqual(["c"]);
  });

  it("has nothing to pack when there are no photos", () => {
    expect(packMosaicRows([])).toEqual([]);
  });
});

describe("groupLayout", () => {
  it("reads the three plates, and treats everything else as the mosaic default", () => {
    expect(groupLayout("mosaic")).toBe("mosaic");
    expect(groupLayout("grid")).toBe("grid");
    expect(groupLayout("stack")).toBe("stack");
    // A block that became a group may still carry a single photo's layout.
    expect(groupLayout(null)).toBe("mosaic");
    expect(groupLayout("wide")).toBe("mosaic");
    expect(groupLayout("default")).toBe("mosaic");
  });
});

describe("StoryPhotoGroup", () => {
  it("draws the plate the author chose", () => {
    const photos = [landscape("a"), landscape("b")];
    const { container, rerender } = render(
      <StoryPhotoGroup photos={photos} layout="grid" onOpen={() => {}} />
    );
    expect(container.querySelector(".story-photo-group")).toHaveAttribute("data-layout", "grid");
    rerender(<StoryPhotoGroup photos={photos} layout="stack" onOpen={() => {}} />);
    expect(container.querySelector(".story-photo-group")).toHaveAttribute("data-layout", "stack");
    rerender(<StoryPhotoGroup photos={photos} layout={null} onOpen={() => {}} />);
    expect(container.querySelector(".story-photo-group")).toHaveAttribute("data-layout", "mosaic");
  });

  it("shows every photo on every plate", () => {
    for (const layout of ["mosaic", "grid", "stack"]) {
      const { container, unmount } = render(
        <StoryPhotoGroup photos={["a", "b", "c", "d", "e"].map(landscape)} layout={layout} onOpen={() => {}} />
      );
      expect(container.querySelectorAll("img")).toHaveLength(5);
      unmount();
    }
  });

  it("opens the lightbox at the photo that was clicked, in the authored order", async () => {
    const onOpen = vi.fn();
    // Four landscapes land as two mosaic rows, so the third photo's index has
    // to survive the row packing — the bug this pins.
    render(
      <StoryPhotoGroup photos={["a", "b", "c", "d"].map(landscape)} layout="mosaic" onOpen={onOpen} />
    );
    await userEvent.click(screen.getByRole("button", { name: "Open photo c" }));
    expect(onOpen).toHaveBeenCalledWith(2);
  });

  it("shows each photo's own line where it has one", () => {
    render(
      <StoryPhotoGroup
        photos={[landscape("a"), photo({ id: "b", blockCaption: "Dad on the balcony" })]}
        layout="stack"
        onOpen={() => {}}
      />
    );
    expect(screen.getByText("Dad on the balcony")).toBeInTheDocument();
    // A photo without one gets no empty caption box.
    expect(document.querySelectorAll("figcaption")).toHaveLength(1);
  });

  it("draws nothing at all for an empty group", () => {
    const { container } = render(<StoryPhotoGroup photos={[]} layout="mosaic" onOpen={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
