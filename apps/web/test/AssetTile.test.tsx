import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AssetTile } from "../src/features/gallery/AssetTile";
import type { GalleryAsset } from "../src/features/gallery/types";

const photo = (over: Partial<GalleryAsset> = {}): GalleryAsset => ({
  id: "p1",
  title: "IMG_1224.jpg",
  kind: "photo",
  coverUrl: "/api/library/covers/p1",
  takenAt: "2025-02-27T10:00:00Z",
  addedAt: "2025-03-01T10:00:00Z",
  saved: false,
  ...over
} as GalleryAsset);

const props = (over: Record<string, unknown> = {}) => ({
  asset: photo(),
  selectionMode: false,
  selected: false,
  onOpen: vi.fn(),
  onToggleSelect: vi.fn(),
  ...over
});

describe("AssetTile", () => {
  it("labels the tile by what clicking it will do", () => {
    render(<AssetTile {...props()} />);
    expect(screen.getByRole("button", { name: "Open IMG_1224.jpg" })).toBeInTheDocument();
  });

  it("opens the lightbox when clicked", async () => {
    const onOpen = vi.fn();
    render(<AssetTile {...props({ onOpen })} />);

    await userEvent.click(screen.getByRole("button", { name: /^Open/ }));

    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("selects instead of opening once selection mode is on", async () => {
    const onOpen = vi.fn();
    const onToggleSelect = vi.fn();
    render(<AssetTile {...props({ selectionMode: true, onOpen, onToggleSelect })} />);

    await userEvent.click(screen.getByRole("button", { name: "Select IMG_1224.jpg" }));

    expect(onToggleSelect).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("marks a selected tile as pressed for assistive tech", () => {
    render(<AssetTile {...props({ selectionMode: true, selected: true })} />);
    expect(screen.getByRole("button", { name: /^Select/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows no remove button unless the caller supplies one", () => {
    render(<AssetTile {...props()} />);
    expect(screen.queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument();
  });

  it("removes, and does not also open the tile behind it", async () => {
    const onRemove = vi.fn();
    const onOpen = vi.fn();
    render(<AssetTile {...props({ onRemove, onOpen, removeTitle: "Remove from this album" })} />);

    const remove = screen.getByRole("button", { name: "Remove IMG_1224.jpg" });
    expect(remove).toHaveAttribute("title", "Remove from this album");
    await userEvent.click(remove);

    expect(onRemove).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("falls back to an icon when the asset has no thumbnail", () => {
    const { container } = render(<AssetTile {...props({ asset: photo({ coverUrl: null }) })} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".gallery-tile-fallback")).toBeInTheDocument();
  });

  it("badges a video, and says so differently when the browser cannot play it", () => {
    const { rerender, container } = render(
      <AssetTile {...props({ asset: photo({ kind: "video", playable: true }) })} />
    );
    expect(container.querySelector(".gallery-video-badge")).toBeInTheDocument();
    expect(container.querySelector(".gallery-video-badge.unplayable")).toBeNull();

    rerender(<AssetTile {...props({ asset: photo({ kind: "video", playable: false }) })} />);
    expect(container.querySelector(".gallery-video-badge.unplayable")).toBeInTheDocument();
  });

  it("badges an audio recording and falls back to the mic, not the photo icon", () => {
    const { container } = render(
      <AssetTile {...props({ asset: photo({ kind: "audio", coverUrl: null }) })} />
    );
    expect(container.querySelector(".gallery-video-badge")).toHaveTextContent("Audio");
    expect(container.querySelector(".gallery-tile-fallback svg.lucide-mic")).toBeInTheDocument();
  });

  it("shows the liked dot only outside selection mode, where the check goes", () => {
    const { container, rerender } = render(
      <AssetTile {...props({ asset: photo({ saved: true }) })} />
    );
    expect(container.querySelector(".gallery-like-dot")).toBeInTheDocument();

    rerender(<AssetTile {...props({ asset: photo({ saved: true }), selectionMode: true, selected: true })} />);
    expect(container.querySelector(".gallery-like-dot")).toBeNull();
    expect(container.querySelector(".gallery-tile-check")).toBeInTheDocument();
  });
});
