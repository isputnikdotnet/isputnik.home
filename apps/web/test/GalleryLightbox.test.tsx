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
  canShare: false,
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

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Move to Recycle Bin" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ kind: "deleted", id: "p1" }));
  });

  it("reports a rotate as a change to the asset itself", async () => {
    const onChanged = vi.fn();
    render(<GalleryLightbox {...props({ onChanged })} />);

    await userEvent.click(screen.getByRole("button", { name: "Rotate right" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ kind: "asset", id: "p1" }));
  });
});
