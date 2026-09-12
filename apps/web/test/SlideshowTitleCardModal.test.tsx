import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/features/gallery/PhotoPicker", () => ({ PhotoPicker: () => <div /> }));

const { SlideshowTitleCardModal } = await import("../src/features/gallery/SlideshowTitleCardModal");
import type { GallerySlideshowDetail } from "../src/features/gallery/types";

function slideshow(over: Partial<GallerySlideshowDetail> = {}): GallerySlideshowDetail {
  return {
    id: "s1", name: "One summer", transition: "crossfade", slideSeconds: 4, transitionSeconds: 2,
    coverItemId: null, canEdit: true, updatedAt: "2020-01-01", tags: [], outroClip: null,
    movieTargetLibraryId: null, movieOnConflict: "rename", movieFileStem: null,
    movieFileName: "one-summer.mp4", movieSaveError: null, musicTrackId: null, musicTitle: null,
    musicUrl: null, renderStatus: "none", renderStale: false, renderError: null,
    renderPercent: null, renderedAt: null, outputBytes: null, movieUrl: null,
    movieSavedToLibrary: false,
    titleEnabled: true, titleText: null, titleSubtitleMode: "count", titleSubtitle: null,
    titleSeconds: 3, titleBackground: "black", titlePhotoItemId: null,
    cardFont: "classic", cardSize: "medium",
    closingEnabled: false, closingText: null, closingLines: null, closingSeconds: 5,
    closingBackground: "black", closingPhotoItemId: null, outroSound: true,
    ...over
  } as GallerySlideshowDetail;
}

// This dialog is the only thing that writes titleSeconds/closingSeconds, so the two
// dwell sliders are seeded once — like the text fields beside them — instead of
// following the prop from an effect. That effect meant any OTHER patch made here
// (a background, a font) re-rendering the parent mid-drag snapped the handle back.
function Harness() {
  const [show, setShow] = useState(slideshow());
  const [tick, setTick] = useState(0);
  return (
    <>
      <SlideshowTitleCardModal slideshow={show} assets={[]} onPatch={() => {}} onClose={() => {}} />
      {/* Another setting saved: the parent re-reads the slideshow. */}
      <button type="button" onClick={() => setShow(slideshow({ cardFont: "serif" }))}>other setting saved</button>
      <button type="button" onClick={() => setTick(tick + 1)}>re-render {tick}</button>
    </>
  );
}

const dwell = () => screen.getByLabelText("On screen for") as HTMLInputElement;

describe("SlideshowTitleCardModal dwell slider", () => {
  it("opens on the stored seconds", () => {
    render(<Harness />);
    expect(dwell()).toHaveValue("3");
  });

  it("keeps the handle where it was dragged when another setting is saved", () => {
    render(<Harness />);
    fireEvent.change(dwell(), { target: { value: "7" } });
    expect(dwell()).toHaveValue("7");
    fireEvent.click(screen.getByRole("button", { name: "other setting saved" }));
    expect(dwell()).toHaveValue("7");
  });

  it("does not reset the handle on an unrelated re-render", () => {
    render(<Harness />);
    fireEvent.change(dwell(), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: /re-render/ }));
    expect(dwell()).toHaveValue("9");
  });
});
