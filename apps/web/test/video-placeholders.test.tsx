import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PosterGrid, PosterRow, type PosterItem } from "../src/features/video/VideoPoster";
import { DEFAULT_COVERS, DEFAULT_WIDE_COVERS, placeholderForEntity } from "../src/features/audiobooks/covers";

// A film or show with no poster yet wears its kind's placeholder art
// (apps/web/public/Assets/covers) with its name on it, in the cut of its card.

const item = (over: Partial<PosterItem> = {}): PosterItem => ({
  key: "m1", href: "/video/movies/m1", title: "Loose Film", sub: "1999", poster: null, kind: "movie", ...over
});

describe("video cards without a poster", () => {
  it("show the kind's poster art with the name over it", () => {
    render(<PosterGrid items={[item(), item({ key: "s1", title: "Some Show", sub: "2004", kind: "show" })]} />);
    const covers = Array.from(document.querySelectorAll(".video-card-cover.is-placeholder > img"));
    expect(covers.map((img) => img.getAttribute("src"))).toEqual([DEFAULT_COVERS.movie, DEFAULT_COVERS.show]);
    expect(screen.getByText("Loose Film").closest(".video-card-blank")).not.toBeNull();
    expect(screen.getByText("1999").closest(".video-card-blank")).not.toBeNull();
  });

  it("use the wide frame on a wide card", () => {
    render(<PosterRow title="Continue watching" shape="wide" items={[item({ kind: "show" })]} />);
    expect(document.querySelector(".video-card-cover > img")).toHaveAttribute("src", DEFAULT_WIDE_COVERS.show);
  });

  it("give way to a real poster, whose name sits underneath", () => {
    render(<PosterGrid items={[item({ poster: "/video/api/art/m1/poster?v=1" })]} />);
    expect(document.querySelector(".video-card-cover.has-poster > img")).toHaveAttribute("src", "/video/api/art/m1/poster?v=1");
    expect(document.querySelector(".video-card-blank")).toBeNull();
    expect(screen.getByText("Loose Film").closest(".video-card-body")).not.toBeNull();
  });
});

describe("collection entries without a cover", () => {
  it("map each collectable kind to its placeholder", () => {
    expect(placeholderForEntity("audiobook")).toBe(DEFAULT_COVERS.audiobook);
    expect(placeholderForEntity("ebook")).toBe(DEFAULT_COVERS.ebook);
    expect(placeholderForEntity("video_movie")).toBe(DEFAULT_COVERS.movie);
    expect(placeholderForEntity("video_show")).toBe(DEFAULT_COVERS.show);
    expect(placeholderForEntity("gallery")).toBeNull();
  });
});
