import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FamilyPerson } from "../src/features/familytree/types";
import type { GalleryAsset } from "../src/features/gallery/types";
import { centredFrame, frameAroundBox } from "../src/shared/ImageCropper";
import { renderSignedIn } from "./helpers/session";

// Cutting a portrait out of a group photo (docs/people-sharing-plan.md, phase 4):
// the linked person's face is framed first, any other face is one click away,
// and what is saved is the frame on the photo as shown.

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});

const { api } = await import("../src/api");
const { PortraitCropModal } = await import("../src/features/familytree/PortraitCropModal");
const mockApi = vi.mocked(api);

const IVAN_BOX = { x: 0.6, y: 0.2, w: 0.1, h: 0.2 };
const GUEST_BOX = { x: 0.1, y: 0.3, w: 0.1, h: 0.2 };

const person: FamilyPerson = {
  id: "fp1", name: "Ivan", maidenName: null, otherNames: [], gender: "male", birthDate: null, deathDate: null,
  birthplace: null, deathPlace: null, birthPin: null, deathPin: null, bio: null,
  portraitUrl: null, portraitItemId: null, portraitCrop: null, galleryPersonId: "gp-ivan", tags: [], canEdit: true
};

const asset = {
  id: "p1",
  title: "party.jpg",
  previewUrl: "/api/library/covers/lib/p1-cover-large.webp",
  coverUrl: null,
  faces: [
    { id: "f-guest", box: GUEST_BOX, personId: null, personName: null, confirmed: false, thumbUrl: null },
    { id: "f-ivan", box: IVAN_BOX, personId: "gp-ivan", personName: "Ivan", confirmed: true, thumbUrl: null }
  ]
} as unknown as GalleryAsset;

// jsdom loads no pictures: give the <img> a size and say it loaded.
function loadPicture(width: number, height: number) {
  const img = document.querySelector(".image-cropper img") as HTMLImageElement;
  Object.defineProperty(img, "naturalWidth", { value: width });
  Object.defineProperty(img, "naturalHeight", { value: height });
  fireEvent.load(img);
}

const frameStyle = () => (document.querySelector(".image-cropper-frame") as HTMLElement | null)?.style;

beforeEach(() => {
  mockApi.mockReset();
  mockApi.mockImplementation(async (path: string) => {
    if (path === "/api/library/gallery/assets/p1") return { asset } as never;
    return {} as never;
  });
});

describe("frames", () => {
  it("around a face: square in pixels, the face filling about 45% of it, on the photo", () => {
    const frame = frameAroundBox(IVAN_BOX, 1000, 500);
    expect(frame.w * 1000).toBeCloseTo(frame.h * 500, 6);
    expect(frame.h * 500).toBeCloseTo((0.2 * 500) / 0.45, 6);
    expect(frame.x + frame.w).toBeLessThanOrEqual(1);
    expect(centredFrame(1000, 500, 1)).toEqual({ x: 0.25, y: 0, w: 0.5, h: 1 });
  });
});

describe("PortraitCropModal", () => {
  it("frames the linked person's face first, reframes on another face, and saves that frame", async () => {
    const onSaved = vi.fn();
    renderSignedIn(<PortraitCropModal person={person} itemId="p1" onClose={() => {}} onSaved={onSaved} />);
    await screen.findByRole("dialog", { name: "Portrait of Ivan" });
    await waitFor(() => expect(document.querySelector(".image-cropper img")).not.toBeNull());
    loadPicture(1000, 500);

    const ivan = frameAroundBox(IVAN_BOX, 1000, 500);
    await waitFor(() => expect(frameStyle()?.left).toBe(`${ivan.x * 100}%`));

    await userEvent.click(screen.getByRole("button", { name: "Frame this face" }));
    const guest = frameAroundBox(GUEST_BOX, 1000, 500);
    expect(frameStyle()?.left).toBe(`${guest.x * 100}%`);

    await userEvent.click(screen.getByRole("button", { name: "Save portrait" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const call = mockApi.mock.calls.find(([path]) => path === "/api/family-tree/persons/fp1/portrait/crop");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ itemId: "p1", crop: guest });
  });

  it("re-cropping the same photo starts from the frame it was cut to", async () => {
    const saved = { x: 0.1, y: 0.1, w: 0.4, h: 0.8 };
    renderSignedIn(
      <PortraitCropModal person={{ ...person, portraitItemId: "p1", portraitCrop: saved }} itemId="p1" onClose={() => {}} onSaved={() => {}} />
    );
    await waitFor(() => expect(document.querySelector(".image-cropper img")).not.toBeNull());
    loadPicture(1000, 500);
    expect(frameStyle()).toMatchObject({ left: "10%", top: "10%", width: "40%", height: "80%" });
  });

  it("moves the frame with the arrow keys, and keeps it on the photo", async () => {
    renderSignedIn(<PortraitCropModal person={person} itemId="p1" onClose={() => {}} onSaved={() => {}} />);
    await waitFor(() => expect(document.querySelector(".image-cropper img")).not.toBeNull());
    loadPicture(1000, 500);
    const frame = await waitFor(() => screen.getByRole("group", { name: /Crop frame/ }));
    const before = parseFloat(frameStyle()!.left);
    fireEvent.keyDown(frame, { key: "ArrowLeft" });
    expect(parseFloat(frameStyle()!.left)).toBeCloseTo(before - 1, 6);
    for (let i = 0; i < 200; i += 1) fireEvent.keyDown(frame, { key: "ArrowLeft", shiftKey: true });
    expect(frameStyle()!.left).toBe("0%");
  });
});
