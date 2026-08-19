import { beforeEach, describe, expect, it } from "vitest";
import { CONTROL_PATHS, controlHref, getReferrer, getRoute, profileHref } from "../src/router";

// The router is a pure path -> route table with a long tail of aliases kept for
// old bookmarks. Nothing type-checks a wrong answer here: a mis-parsed path just
// renders the wrong page, or silently falls through to Home.

const at = (url: string) => window.history.replaceState({}, "", url);

beforeEach(() => at("/"));

describe("getRoute", () => {
  it("reads the landing page", () => {
    expect(getRoute()).toEqual({ name: "home" });
  });

  it.each([
    ["/install", "install"],
    ["/login", "login"],
    ["/gallery", "gallery"],
    ["/audiobooks", "audiobooks"],
    ["/ebooks", "ebooks"],
    ["/about", "about"],
    ["/help", "help"],
    ["/downloads", "downloads"],
    ["/favorites", "favorites"],
    ["/quotes", "quotes"]
  ])("maps %s to the %s route", (path, name) => {
    at(path);
    expect(getRoute().name).toBe(name);
  });

  it("pulls the token out of an invite link", () => {
    at("/invite/abc123");
    expect(getRoute()).toEqual({ name: "invite", token: "abc123" });
  });

  it("pulls the token out of a guest share link", () => {
    at("/share/tok-xyz");
    expect(getRoute()).toEqual({ name: "share", token: "tok-xyz" });
  });

  it("does not treat a deeper path as an invite", () => {
    at("/invite/abc/extra");
    expect(getRoute().name).not.toBe("invite");
  });

  it("falls back to home for something unrecognised", () => {
    at("/no/such/page");
    expect(getRoute()).toEqual({ name: "home" });
  });

  it("routes every canonical control path to the control section it names", () => {
    for (const [section, path] of Object.entries(CONTROL_PATHS)) {
      at(path);
      const route = getRoute();
      expect(route.name, `${path} should be a control route`).toBe("control");
      expect((route as { section: string }).section, `${path}`).toBe(section);
    }
  });

  it("keeps the old duplicate-cleanup bookmarks working", () => {
    for (const legacy of [
      "/control/utilities/duplicate-photos",
      "/control/libraries/duplicate-photos",
      "/control/duplicate-photos",
      "/control/maintenance/duplicate-folders"
    ]) {
      at(legacy);
      const route = getRoute();
      expect(route.name, legacy).toBe("control");
      expect((route as { section: string }).section, legacy).toBe("duplicateCleanup");
    }
  });
});

describe("getReferrer", () => {
  // ?from= comes back as an href, so it is an open-redirect hole if it is not
  // constrained to this origin. These are the cases that make it one.
  it("returns nothing when absent", () => {
    at("/gallery");
    expect(getReferrer()).toBeNull();
  });

  it("accepts a same-origin path", () => {
    at("/people/x?from=/audiobooks");
    expect(getReferrer()).toBe("/audiobooks");
  });

  it("keeps the query and hash of the path it was given", () => {
    at(`/x?from=${encodeURIComponent("/audiobooks?sort=title#top")}`);
    expect(getReferrer()).toBe("/audiobooks?sort=title#top");
  });

  it.each([
    ["an absolute URL elsewhere", "https://evil.example/phish"],
    ["a protocol-relative URL", "//evil.example/phish"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a bare word", "audiobooks"]
  ])("refuses %s", (_label, value) => {
    at(`/x?from=${encodeURIComponent(value)}`);
    expect(getReferrer()).toBeNull();
  });
});

describe("href builders", () => {
  it("gives each control section its canonical path", () => {
    expect(controlHref("dashboard")).toBe(CONTROL_PATHS.dashboard);
    expect(controlHref("duplicateCleanup")).toBe(CONTROL_PATHS.duplicateCleanup);
  });

  it("round-trips: every controlHref parses back to its own section", () => {
    for (const section of Object.keys(CONTROL_PATHS) as (keyof typeof CONTROL_PATHS)[]) {
      at(controlHref(section));
      expect((getRoute() as { section: string }).section, section).toBe(section);
    }
  });

  it("round-trips profile tabs the same way", () => {
    for (const tab of ["account", "security", "shares", "appearance", "devices"] as const) {
      at(profileHref(tab));
      const route = getRoute();
      expect(route.name, tab).toBe("profile");
      expect((route as { tab: string }).tab, tab).toBe(tab);
    }
  });
});
