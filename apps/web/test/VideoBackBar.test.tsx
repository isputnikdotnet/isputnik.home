import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VideoBackBar } from "../src/features/video/VideoBackBar";

// The way back from a film: one arrow naming the list when the list is where
// the visitor came from, else Back to the screen before and the list beside it.
// "← Movies" used to step back through every film opened from another.
afterEach(() => window.history.replaceState(null, "", "/"));

const at = (from: string | null) => window.history.replaceState(from ? { appNav: 2, from } : null, "", "/video/movies/abc");

describe("the way back from a film", () => {
  it("is one arrow to the list when the list is where they came from", () => {
    at("/video/movies?sort=added");
    render(<VideoBackBar list="/video/movies" listLabel="Movies" />);
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["Movies"]);
  });

  it("is one arrow to the list from a link from outside the app", () => {
    at(null);
    render(<VideoBackBar list="/video/movies" listLabel="Movies" />);
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["Movies"]);
  });

  it("is Back and the list, one after another film", () => {
    at("/video/movies/other-film");
    render(<VideoBackBar list="/video/movies" listLabel="Movies" />);
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["Back", "Movies"]);
    expect(links[1].getAttribute("href")).toBe("/video/movies");
  });
});
