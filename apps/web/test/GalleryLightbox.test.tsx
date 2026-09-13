import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Every request the viewer makes, answered by shape. The viewer fires a "viewed"
// ping and refetches its own asset on open, so a bare stub would break rendering
// before the test got to the thing it is about.
vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});

import { api } from "../src/api";
import { GalleryLightbox } from "../src/features/gallery/GalleryLightbox";
import type { GalleryAsset } from "../src/features/gallery/types";

const photo = (over: Partial<GalleryAsset> = {}): GalleryAsset => ({
  id: "p1",
  libraryId: "lib-1",
  title: "IMG_1224.jpg",
  kind: "photo",
  folderPath: "2025/IMG_1224.jpg",
  folder: "2025",
  coverUrl: "/api/library/covers/p1",
  previewUrl: "/api/library/covers/p1",
  fileUrl: "/api/library/gallery/assets/p1/file",
  playbackUrl: "/api/library/gallery/assets/p1/file",
  takenAt: "2025-02-27T10:00:00Z",
  addedAt: "2025-03-01T10:00:00Z",
  tags: [],
  saved: false,
  ...over
} as GalleryAsset);

const props = (over: Record<string, unknown> = {}) => ({
  assets: [photo(), photo({ id: "p2", title: "IMG_1225.jpg" })],
  index: 0,
  canDelete: true,
  canEdit: true,
  onClose: vi.fn(),
  onIndexChange: vi.fn(),
  onChanged: vi.fn(),
  ...over
});

beforeEach(() => {
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path.endsWith("/people")) return { people: [] } as never;
    if (/\/api\/library\/gallery\/assets\/[^/]+$/.test(path)) return { asset: photo() } as never;
    return {} as never;
  });
});

// The host decides how much to redo, so what the viewer SAYS happened is the
// contract: a like moves nothing (the host patches the photo where it sits),
// while a delete takes a row out. Reporting a like as a plain change is what
// used to throw away the visitor's "Load more" pages and close the viewer.
describe("GalleryLightbox change signal", () => {
  it("reports a like as a like, not as a change that redraws the view", async () => {
    const onChanged = vi.fn();
    render(<GalleryLightbox {...props({ onChanged })} />);

    await userEvent.click(screen.getByRole("button", { name: "Like" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ kind: "like", id: "p1", saved: true }));
  });

  it("reports an unlike the same way, with the new state", async () => {
    const onChanged = vi.fn();
    render(<GalleryLightbox {...props({ onChanged, assets: [photo({ saved: true })] })} />);

    await userEvent.click(screen.getByRole("button", { name: "Unlike" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ kind: "like", id: "p1", saved: false }));
  });

  it("reports a delete as a delete", async () => {
    const onChanged = vi.fn();
    render(<GalleryLightbox {...props({ onChanged })} />);

    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Move to Recycle Bin" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ kind: "deleted", id: "p1" }));
  });

  it("reports a rotate as a change to the asset itself", async () => {
    const onChanged = vi.fn();
    render(<GalleryLightbox {...props({ onChanged })} />);

    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Rotate right" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ kind: "asset", id: "p1" }));
  });
});

// The viewer is ONE mounted component that pages through the set, so the heart has
// to belong to whichever photo is on screen and to nothing else. It is derived from
// the asset (with an optimistic flip remembered against it), not a copy of
// `asset.saved` that an effect puts back in step one render later — that render
// showed the previous photo's heart, and a click in it liked the wrong photo.
describe("GalleryLightbox like state follows the photo", () => {
  it("shows the heart of the photo on screen, not the one before it", () => {
    const assets = [photo(), photo({ id: "p2", title: "IMG_1225.jpg", saved: true })];
    const { rerender } = render(<GalleryLightbox {...props({ assets })} />);
    expect(screen.getByRole("button", { name: "Like" })).toBeInTheDocument();

    // Paging: the host re-renders the same viewer with the next index.
    rerender(<GalleryLightbox {...props({ assets, index: 1 })} />);
    expect(screen.getByRole("button", { name: "Unlike" })).toBeInTheDocument();
  });

  it("adopts a saved value the host changes under it", () => {
    const { rerender } = render(<GalleryLightbox {...props({ assets: [photo()] })} />);
    expect(screen.getByRole("button", { name: "Like" })).toBeInTheDocument();

    rerender(<GalleryLightbox {...props({ assets: [photo({ saved: true })] })} />);
    expect(screen.getByRole("button", { name: "Unlike" })).toBeInTheDocument();
  });

  it("keeps an optimistic like across a re-render the host has not caught up with", async () => {
    const assets = [photo()];
    const { rerender } = render(<GalleryLightbox {...props({ assets })} />);
    await userEvent.click(screen.getByRole("button", { name: "Like" }));
    expect(screen.getByRole("button", { name: "Unlike" })).toBeInTheDocument();

    rerender(<GalleryLightbox {...props({ assets })} />);
    expect(screen.getByRole("button", { name: "Unlike" })).toBeInTheDocument();
  });
});

// A list row carries a place only as an id; the name, in the viewer's language,
// comes with the photo's details. Showing the row's (absent) label is what left a
// photo opened from the grid with no place at all.
describe("GalleryLightbox named place", () => {
  it("shows the place from the photo's details when the row only knew its id", async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.endsWith("/people")) return { people: [] } as never;
      if (/\/api\/library\/gallery\/assets\/[^/]+$/.test(path)) {
        return {
          asset: photo({
            people: [], voiceNotes: [], gps: { lat: 45.46, lng: 9.19 }, place: { id: 3173435, distanceKm: 0.8 },
            placeLabel: { place: "Milan", region: "Lombardy", country: "Italy", countryCode: "IT" }
          })
        } as never;
      }
      return {} as never;
    });
    render(<GalleryLightbox {...props({ assets: [photo({ gps: { lat: 45.46, lng: 9.19 }, place: { id: 3173435, distanceKm: 0.8 } })] })} />);
    expect(await screen.findByText("Milan, Lombardy, Italy")).toBeInTheDocument();
  });
});
