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

beforeEach(() => {
  items = [photo(), photo({ id: "p2", title: "002.jpg", folderPath: "box3/002.jpg" })];
  patches = [];
  posts = [];
  vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/library/gallery/inbox") return { inboxes: [inbox] } as never;
    if (path.startsWith("/api/library/gallery/inbox/inbox/items")) return { items, total: items.length } as never;
    if (path.startsWith("/api/library/gallery/people")) return { people: [{ id: "mama", name: "Mama", faceCount: 12, coverUrl: null }] } as never;
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
    render(<ReviewPage libraryId="inbox" folder="box3" />);
    expect(await screen.findByText("1 of 2")).toBeInTheDocument();

    await user.selectOptions(await screen.findByLabelText("Year"), "1962");
    await user.click(screen.getByRole("button", { name: "About" }));
    await user.type(screen.getByLabelText("Where?"), "the dacha");
    await user.type(screen.getByLabelText("Anything you remember?"), "Papa built the fence that summer");
    await user.click(screen.getByRole("button", { name: "Mama" }));
    await user.click(screen.getByRole("button", { name: "Next" }));

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

  it("does not offer the scan date as an answer, and leaves the date alone when nothing was chosen", async () => {
    const user = userEvent.setup();
    render(<ReviewPage libraryId="inbox" folder="box3" />);
    await screen.findByText("1 of 2");
    expect((await screen.findByLabelText("Year") as HTMLSelectElement).value).toBe("");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    // The stored (scan) date travels back unchanged and no precision is sent.
    expect(patches[0].body.takenAt).toBe("2026-09-07T10:00:00Z");
    expect(patches[0].body.takenPrecision).toBeUndefined();
  });

  it("copies the previous photo's answers with 'Same as the last one'", async () => {
    const user = userEvent.setup();
    render(<ReviewPage libraryId="inbox" folder="box3" />);
    await screen.findByText("1 of 2");
    await user.selectOptions(await screen.findByLabelText("Year"), "1962");
    await user.selectOptions(screen.getByLabelText("Month"), "7");
    await user.type(screen.getByLabelText("Where?"), "Ratomka");
    await user.click(screen.getByRole("button", { name: "Next" }));
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
    render(<ReviewPage libraryId="inbox" folder="box3" />);
    await screen.findByText("1 of 2");
    await user.click(await screen.findByRole("button", { name: "I don't know" }));
    await screen.findByText("2 of 2");
    await user.click(screen.getByRole("button", { name: "I don't know" }));
    expect(await screen.findByText("You went through all of them")).toBeInTheDocument();
    expect(patches).toHaveLength(0);
    expect(posts).toEqual(["/api/library/gallery/assets/p1/reviewed", "/api/library/gallery/assets/p2/reviewed"]);
  });

  it("is read-only without the edit right", async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/library/gallery/inbox") return { inboxes: [{ ...inbox, canEdit: false }] } as never;
      if (path.startsWith("/api/library/gallery/inbox/inbox/items")) return { items, total: items.length } as never;
      if (path.startsWith("/api/library/gallery/people")) return { people: [] } as never;
      if (/\/api\/library\/gallery\/assets\/[^/]+$/.test(path)) return { asset: items[0] } as never;
      return {} as never;
    });
    render(<ReviewPage libraryId="inbox" folder={null} />);
    expect(await screen.findByText("Viewing only")).toBeInTheDocument();
    expect(screen.getByLabelText("Where?")).toBeDisabled();
  });
});
