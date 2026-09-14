import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});

import { api } from "../src/api";
import { GalleryFaceOverlay } from "../src/features/gallery/GalleryFaceOverlay";
import type { GalleryAsset, GalleryFace } from "../src/features/gallery/types";

// jsdom lays nothing out, so the photo the layer covers is given a size by hand.
function sizedImage(): HTMLImageElement {
  const img = document.createElement("img");
  Object.defineProperties(img, {
    offsetWidth: { value: 800 }, offsetHeight: { value: 600 },
    offsetLeft: { value: 0 }, offsetTop: { value: 0 }
  });
  return img;
}

const mum: GalleryFace = { id: "f1", box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, personId: "p-mum", personName: "Mum", confirmed: false, thumbUrl: null };
const stranger: GalleryFace = { id: "f2", box: { x: 0.6, y: 0.1, w: 0.2, h: 0.2 }, personId: "g1", personName: "", confirmed: false, thumbUrl: null };

beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path === "/api/library/gallery/people") return { people: [{ id: "p-mum", name: "Mum", faceCount: 3, coverUrl: null }] } as never;
    return { asset: { id: "a1", faces: [] } as unknown as GalleryAsset } as never;
  });
});

describe("GalleryFaceOverlay", () => {
  it("draws nothing until faces are shown or a person is highlighted", () => {
    const image = sizedImage();
    const { rerender } = render(
      <GalleryFaceOverlay image={image} faces={[mum, stranger]} showAll={false} highlightPersonId={null} canEdit={false} onChanged={vi.fn()} />
    );
    expect(screen.queryByTitle("Mum")).toBeNull();

    // Hovering Mum's chip lights up her face only.
    rerender(<GalleryFaceOverlay image={image} faces={[mum, stranger]} showAll={false} highlightPersonId="p-mum" canEdit={false} onChanged={vi.fn()} />);
    expect(screen.getByTitle("Mum")).toHaveStyle({ left: "10%", width: "20%" });
    expect(screen.queryByTitle("Not named yet")).toBeNull();

    rerender(<GalleryFaceOverlay image={image} faces={[mum, stranger]} showAll highlightPersonId={null} canEdit={false} onChanged={vi.fn()} />);
    expect(screen.getByTitle("Not named yet")).toBeInTheDocument();
  });

  it("names an unnamed face, with its group by default, through the face's own route", async () => {
    const onChanged = vi.fn();
    render(<GalleryFaceOverlay image={sizedImage()} faces={[mum, stranger]} showAll highlightPersonId={null} canEdit onChanged={onChanged} />);

    await userEvent.click(screen.getByRole("button", { name: "Name this face (Not named yet)" }));
    expect(screen.getByRole("checkbox")).toBeChecked();
    await userEvent.type(screen.getByRole("combobox", { name: "Who is this?" }), "Aunt Olga");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api).toHaveBeenCalledWith("/api/library/gallery/faces/f2/person", {
      method: "PUT",
      body: JSON.stringify({ name: "Aunt Olga", wholeGroup: true })
    });
  });

  it("says 'Not Mum' for that one face", async () => {
    const onChanged = vi.fn();
    render(<GalleryFaceOverlay image={sizedImage()} faces={[mum, stranger]} showAll highlightPersonId={null} canEdit onChanged={onChanged} />);

    await userEvent.click(screen.getByRole("button", { name: "Name this face (Mum)" }));
    await userEvent.click(screen.getByRole("button", { name: "Not Mum" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api).toHaveBeenCalledWith("/api/library/gallery/faces/f1/person", { method: "DELETE" });
  });
});
