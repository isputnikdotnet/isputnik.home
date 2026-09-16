import { configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Each test walks a whole photo through a form with a 177-option year list;
// under the full suite's parallel load that brushed the 5s default.
vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

// Review mode (docs/photo-review-plan.md, phase 2): one photo, four questions,
// Next saves. The page's whole contract is what it sends: a year picked from
// the list becomes a year-precise date, "Same as the last one" copies the
// previous photo's answer, and "I don't know" marks the photo without a PATCH.

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});

import { api } from "../src/api";
import { ReviewPage } from "../src/features/gallery/review/ReviewPage";
import type { GalleryAsset } from "../src/features/gallery/types";

const photo = (over: Partial<GalleryAsset> = {}): GalleryAsset => ({
  id: "p1",
  libraryId: "inbox",
  libraryName: "Scans",
  title: "001.jpg",
  kind: "photo",
  folderPath: "box3/001.jpg",
  folder: "box3",
  coverUrl: "/api/library/covers/p1",
  previewUrl: "/api/library/covers/p1",
  fileUrl: "/api/library/gallery/assets/p1/file",
  playbackUrl: "/api/library/gallery/assets/p1/file",
  takenAt: "2026-09-07T10:00:00Z",
  takenPrecision: "time",
  takenApprox: false,
  placeText: null,
  reviewedAt: null,
  reviewedBy: null,
  addedAt: "2026-09-07T10:00:00Z",
  description: null,
  tags: [],
  saved: false,
  people: [],
  ...over
} as GalleryAsset);

const inbox = { id: "inbox", name: "Scans", count: 2, reviewed: 0, canReview: false, canEdit: true, deliveries: [] };

let items: GalleryAsset[];
let patches: { path: string; body: Record<string, unknown> }[];
let posts: string[];
let suggests: string[];
let geocodes: string[];

beforeEach(() => {
  items = [photo(), photo({ id: "p2", title: "002.jpg", folderPath: "box3/002.jpg" })];
  patches = [];
  posts = [];
  suggests = [];
  geocodes = [];
  vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/library/gallery/inbox") return { inboxes: [inbox] } as never;
    if (path.startsWith("/api/library/gallery/inbox/inbox/items")) return { items, total: items.length } as never;
    if (path.startsWith("/api/library/gallery/people")) return { people: [{ id: "mama", name: "Mama", faceCount: 12, coverUrl: null }] } as never;
    if (path.startsWith("/api/library/gallery/place-suggest")) {
      suggests.push(decodeURIComponent(path.split("q=")[1]));
      return { available: true, results: /^mins/i.test(decodeURIComponent(path.split("q=")[1])) ? [{ label: "Minsk, Minsk City, Belarus", lat: 53.9, lng: 27.56667 }] : [] } as never;
    }
    if (path.startsWith("/api/library/gallery/geocode")) {
      geocodes.push(decodeURIComponent(path.split("q=")[1]));
      return { results: [{ label: "Ratomka, Minsk District, Minsk Region, Belarus", lat: 53.95, lng: 27.33 }] } as never;
    }
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      patches.push({ path, body });
      const id = path.split("/")[5];
      const current = items.find((item) => item.id === id)!;
      const saved = {
        ...current,
        description: (body.description as string | null) ?? null,
        placeText: (body.placeText as string | null) ?? null,
        takenAt: (body.takenAt as string) ?? current.takenAt,
        takenPrecision: (body.takenPrecision as GalleryAsset["takenPrecision"]) ?? current.takenPrecision,
        takenApprox: (body.takenApprox as boolean) ?? current.takenApprox,
        reviewedAt: "2026-09-07T12:00:00Z",
        reviewedBy: "Mama"
      };
      items = items.map((item) => (item.id === id ? saved : item));
      return { updated: true, asset: saved } as never;
    }
    if (init?.method === "POST") {
      posts.push(path);
      const id = path.split("/")[5];
      const current = items.find((item) => item.id === id)!;
      if (path.endsWith("/reviewed")) {
        const saved = { ...current, reviewedAt: "2026-09-07T12:00:00Z", reviewedBy: "Mama" };
        items = items.map((item) => (item.id === id ? saved : item));
        return { reviewed: true, asset: saved } as never;
      }
      return { asset: { ...current, people: [{ id: "mama", name: "Mama" }] } } as never;
    }
    if (/\/api\/library\/gallery\/assets\/[^/]+$/.test(path)) {
      const id = path.split("/").pop();
      return { asset: items.find((item) => item.id === id) } as never;
    }
    return {} as never;
  });
});

describe("ReviewPage", () => {
  it("saves a year-only answer, a place and a note on Next, and moves on", async () => {
    const user = userEvent.setup();
    render(<ReviewPage source={{ kind: "inbox", libraryId: "inbox", folder: "box3" }} />);
    expect(await screen.findByText("1 of 2")).toBeInTheDocument();

    await user.selectOptions(await screen.findByLabelText("Year"), "1962");
    await user.click(screen.getByRole("button", { name: "Approximate" }));
    await user.type(screen.getByLabelText("Where?"), "the dacha");
    await user.click(screen.getByRole("button", { name: "Add note" }));
    await user.type(await screen.findByLabelText("What do you remember?"), "Papa built the fence that summer");
    await user.click(screen.getByRole("button", { name: "Save note" }));
    expect(await screen.findByRole("button", { name: "Edit note" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mama" }));
    await user.click(screen.getByRole("button", { name: "Save & Next" }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].path).toBe("/api/library/gallery/assets/p1");
    expect(patches[0].body).toMatchObject({
      takenAt: "1962-01-01T00:00:00.000Z",
      takenPrecision: "year",
      takenApprox: true,
      placeText: "the dacha",
      description: "Papa built the fence that summer",
      reviewed: true
    });
    expect(posts).toContain("/api/library/gallery/assets/p1/people");
    expect(await screen.findByText("2 of 2")).toBeInTheDocument();
  });

  it("still says how the date is read when leaving re-saves the same answer", async () => {
    const user = userEvent.setup();
    // One photo, so Save & Next finishes the box and the page stays on it: the
    // back button then saves that same photo a second time.
    items = [photo()];
    render(<ReviewPage source={{ kind: "inbox", libraryId: "inbox", folder: "box3" }} />);
    await screen.findByText("1 of 1");
    await user.selectOptions(await screen.findByLabelText("Year"), "1983");
    await user.click(screen.getByRole("button", { name: "Approximate" }));
    await user.click(screen.getByRole("button", { name: "Save & Next" }));
    await waitFor(() => expect(patches).toHaveLength(1));

    // Leaving saves the photo a second time. The date has not changed since the
    // first save — but a date sent without its reading is an exact instant to
    // the server, which would harden "about 1983" into 1 Jan 1983, 00:00:00.
    await user.click(screen.getByRole("button", { name: "box3" }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1].body).toMatchObject({
      takenAt: "1983-01-01T00:00:00.000Z",
      takenPrecision: "year",
      takenApprox: true
    });
  });

  it("does not offer the scan date as an answer, and leaves the date alone when nothing was chosen", async () => {
    const user = userEvent.setup();
    render(<ReviewPage source={{ kind: "inbox", libraryId: "inbox", folder: "box3" }} />);
    await screen.findByText("1 of 2");
    expect((await screen.findByLabelText("Year") as HTMLSelectElement).value).toBe("");
    await user.click(screen.getByRole("button", { name: "Save & Next" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    // The stored (scan) date travels back unchanged and no precision is sent.
    expect(patches[0].body.takenAt).toBe("2026-09-07T10:00:00Z");
    expect(patches[0].body.takenPrecision).toBeUndefined();
  });

  it("copies the previous photo's answers with 'Same as the last one'", async () => {
    const user = userEvent.setup();
    render(<ReviewPage source={{ kind: "inbox", libraryId: "inbox", folder: "box3" }} />);
    await screen.findByText("1 of 2");
    await user.selectOptions(await screen.findByLabelText("Year"), "1962");
    await user.selectOptions(screen.getByLabelText("Month"), "7");
    await user.type(screen.getByLabelText("Where?"), "Ratomka");
    await user.click(screen.getByRole("button", { name: "Save & Next" }));
    await screen.findByText("2 of 2");

    const same = screen.getAllByRole("button", { name: "Same as the last one" });
    expect(same).toHaveLength(2);
    await user.click(same[0]);
    await user.click(same[1]);
    expect((screen.getByLabelText("Year") as HTMLSelectElement).value).toBe("1962");
    expect((screen.getByLabelText("Month") as HTMLSelectElement).value).toBe("7");
    expect((screen.getByLabelText("Where?") as HTMLInputElement).value).toBe("Ratomka");
    // The place she already wrote is also a one-tap chip.
    const chips = screen.getByRole("group", { name: "Places you already wrote in this box" });
    expect(within(chips).getByRole("button", { name: "Ratomka" })).toBeInTheDocument();
  });

  it("'I don't know' marks the photo without saving anything, and the end shows a thank-you", async () => {
    const user = userEvent.setup();
    render(<ReviewPage source={{ kind: "inbox", libraryId: "inbox", folder: "box3" }} />);
    await screen.findByText("1 of 2");
    await user.click(await screen.findByRole("button", { name: "Skip / I don't know" }));
    await screen.findByText("2 of 2");
    await user.click(screen.getByRole("button", { name: "Skip / I don't know" }));
    expect(await screen.findByText("You went through all of them")).toBeInTheDocument();
    expect(patches).toHaveLength(0);
    expect(posts).toEqual(["/api/library/gallery/assets/p1/reviewed", "/api/library/gallery/assets/p2/reviewed"]);
  });

  it("walks an album someone asked about, and clears the card at the end", async () => {
    const user = userEvent.setup();
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/library/gallery/review/album/alb1") return { album: { id: "alb1", name: "Summer 1971" }, items, canEdit: true } as never;
      if (path.startsWith("/api/library/gallery/people")) return { people: [] } as never;
      if (init?.method === "POST") { posts.push(path); return { reviewed: true, asset: items.find((item) => item.id === path.split("/")[5]) ?? null } as never; }
      if (/\/api\/library\/gallery\/assets\/[^/]+$/.test(path)) return { asset: items.find((item) => item.id === path.split("/").pop()) } as never;
      return {} as never;
    });
    render(<ReviewPage source={{ kind: "album", albumId: "alb1", recommendationId: "rec9" }} />);
    expect(await screen.findByText("Summer 1971")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Skip / I don't know" }));
    await screen.findByText("2 of 2");
    await user.click(screen.getByRole("button", { name: "Skip / I don't know" }));
    expect(await screen.findByText("You went through all of them")).toBeInTheDocument();
    await waitFor(() => expect(posts).toContain("/api/social/recommendations/rec9/dismiss"));
  });


  // The answers on screen are DERIVED from the photo in front of her, keyed on its
  // id — not a draft re-seeded by an effect, which showed the previous photo's date,
  // place and people under the new one for a render, with a save in that window
  // writing them to the wrong photo.
  it("shows the next photo's own answers, never the previous photo's", async () => {
    const user = userEvent.setup();
    render(<ReviewPage source={{ kind: "inbox", libraryId: "inbox", folder: "box3" }} />);
    await screen.findByText("1 of 2");
    await user.selectOptions(await screen.findByLabelText("Year"), "1962");
    await user.type(screen.getByLabelText("Where?"), "the dacha");
    await user.click(screen.getByRole("button", { name: "Save & Next" }));
    await screen.findByText("2 of 2");

    expect((screen.getByLabelText("Year") as HTMLSelectElement).value).toBe("");
    expect(screen.getByLabelText("Where?")).toHaveValue("");
    // …and the second photo is saved with its OWN blank answers.
    await user.click(screen.getByRole("button", { name: "Save & Next" }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1].path).toBe("/api/library/gallery/assets/p2");
    expect(patches[1].body.placeText).toBeNull();
    expect(patches[1].body.takenPrecision).toBeUndefined();
  });

  it("keeps what she has typed when the photo list is re-read underneath", async () => {
    const user = userEvent.setup();
    render(<ReviewPage source={{ kind: "inbox", libraryId: "inbox", folder: "box3" }} />);
    await screen.findByText("1 of 2");
    await user.type(screen.getByLabelText("Where?"), "the dacha");
    // The detail fetch for the photo lands and rewrites the list entry (people +
    // voice notes) — the typed answer has to survive it.
    await waitFor(() => expect(screen.getByLabelText("Where?")).toHaveValue("the dacha"));
    await user.click(screen.getByRole("button", { name: "Save & Next" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].body.placeText).toBe("the dacha");
  });

  // The note is written in the story editor, in a dialog: what is saved there is
  // markdown, carried by Save & Next like every other answer; closing with words
  // typed asks first and keeps nothing.
  it("writes the note in a dialog and asks before throwing typed words away", async () => {
    const user = userEvent.setup();
    render(<ReviewPage source={{ kind: "inbox", libraryId: "inbox", folder: "box3" }} />);
    await screen.findByText("1 of 2");

    await user.click(screen.getByRole("button", { name: "Add note" }));
    await user.type(await screen.findByLabelText("What do you remember?"), "never mind");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(await screen.findByRole("button", { name: "Discard note" }));
    await waitFor(() => expect(screen.queryByLabelText("What do you remember?")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Add note" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add note" }));
    const editor = await screen.findByLabelText("What do you remember?");
    expect(screen.getByRole("toolbar")).toBeInTheDocument();
    await user.type(editor, "**Papa** built the fence");
    await user.click(screen.getByRole("button", { name: "Save note" }));
    await user.click(await screen.findByRole("button", { name: "Save & Next" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].body.description).toBe("**Papa** built the fence");
  });

  it("finds a known person by search and adds a new name with Enter", async () => {
    const user = userEvent.setup();
    render(<ReviewPage source={{ kind: "inbox", libraryId: "inbox", folder: "box3" }} />);
    await screen.findByText("1 of 2");
    const search = screen.getByLabelText("Search or add a person");

    await user.type(search, "ma{Enter}");
    expect(await screen.findByRole("button", { name: "Remove Mama from this photo" })).toBeInTheDocument();
    await user.type(search, "Dedushka");
    expect(screen.getByRole("button", { name: "Add “Dedushka”" })).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("button", { name: "Remove Dedushka from this photo" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove Mama from this photo" }));
    expect(screen.getByRole("button", { name: "Mama" })).toBeInTheDocument();
  });

  it("keeps Exact when it is pressed before the year", async () => {
    const user = userEvent.setup();
    render(<ReviewPage source={{ kind: "inbox", libraryId: "inbox", folder: "box3" }} />);
    await screen.findByText("1 of 2");
    await user.click(screen.getByRole("button", { name: "Exact" }));
    await user.selectOptions(screen.getByLabelText("Year"), "1962");
    expect(screen.getByRole("button", { name: "Exact" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Save & Next" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].body).toMatchObject({ takenPrecision: "year", takenApprox: false });
  });

  // A place she names can pin the photo: towns as she types come from the
  // server's offline places list; the online lookup is a button, never live.
  it("pins a photo from a town picked while typing the place", async () => {
    const user = userEvent.setup();
    render(<ReviewPage source={{ kind: "inbox", libraryId: "inbox", folder: "box3" }} />);
    await screen.findByText("1 of 2");
    await user.type(screen.getByLabelText("Where?"), "Mins");
    await user.click(await screen.findByRole("button", { name: "Minsk, Minsk City, Belarus" }));
    expect(screen.getByLabelText("Where?")).toHaveValue("Minsk, Belarus");
    expect(screen.getByText("On the map: Minsk, Minsk City, Belarus")).toBeInTheDocument();
    expect(geocodes).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Save & Next" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].body).toMatchObject({ placeText: "Minsk, Belarus", gps: { lat: 53.9, lng: 27.56667 } });
  });

  it("looks a place up online only when asked, and a pin can be left off", async () => {
    const user = userEvent.setup();
    render(<ReviewPage source={{ kind: "inbox", libraryId: "inbox", folder: "box3" }} />);
    await screen.findByText("1 of 2");
    await user.type(screen.getByLabelText("Where?"), "Ratomka");
    await waitFor(() => expect(suggests).toContain("Ratomka"));
    expect(geocodes).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Search online for “Ratomka”" }));
    await user.click(await screen.findByRole("button", { name: "Ratomka, Minsk District, Minsk Region, Belarus" }));
    expect(geocodes).toEqual(["Ratomka"]);
    expect(screen.getByLabelText("Where?")).toHaveValue("Ratomka, Belarus");
    await user.click(screen.getByRole("button", { name: "Do not put it on the map" }));
    await user.click(screen.getByRole("button", { name: "Save & Next" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].body.placeText).toBe("Ratomka, Belarus");
    expect(patches[0].body.gps).toBeUndefined();
  });

  it("never re-pins a photo that already has a location", async () => {
    items = [photo({ gps: { lat: 1, lng: 2 } }), items[1]];
    const user = userEvent.setup();
    render(<ReviewPage source={{ kind: "inbox", libraryId: "inbox", folder: "box3" }} />);
    await screen.findByText("1 of 2");
    expect(screen.getByText("This photo is already on the map.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Where?"), "Minsk");
    expect(screen.queryByRole("button", { name: /Search online/ })).not.toBeInTheDocument();
    expect(suggests).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Save & Next" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].body.gps).toBeUndefined();
  });

  it("is read-only without the edit right", async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/library/gallery/inbox") return { inboxes: [{ ...inbox, canEdit: false }] } as never;
      if (path.startsWith("/api/library/gallery/inbox/inbox/items")) return { items, total: items.length } as never;
      if (path.startsWith("/api/library/gallery/people")) return { people: [] } as never;
      if (/\/api\/library\/gallery\/assets\/[^/]+$/.test(path)) return { asset: items[0] } as never;
      return {} as never;
    });
    render(<ReviewPage source={{ kind: "inbox", libraryId: "inbox", folder: null }} />);
    expect(await screen.findByText("Viewing only")).toBeInTheDocument();
    expect(screen.getByLabelText("Where?")).toBeDisabled();
  });
});
