import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "../src/api";
import type {
  FamilyPerson,
  FamilyPersonProfile,
  FamilyPhoto,
  FamilyTree,
  FamilyUnionDetail
} from "../src/features/familytree/types";
import { SessionContext } from "../src/app/SessionContext";
import { renderSignedIn } from "./helpers/session";

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("../src/app/DashboardShell", () => ({
  DashboardShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}));
const navigate = vi.fn();
vi.mock("../src/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/router")>();
  return {
    ...actual,
    navigate: (path: string) => navigate(path),
    followRoute: (event: React.MouseEvent, path: string) => { event.preventDefault(); navigate(path); }
  };
});
// Stories and notes about a person are their own features with their own
// requests; the profile only decides to show them.
vi.mock("../src/features/stories/RelatedStories", () => ({ RelatedStories: () => null }));
vi.mock("../src/features/social/NotesSection", () => ({ NotesSection: () => null }));

const { api, ApiError } = await import("../src/api");
const { FamilyPersonPage } = await import("../src/features/familytree/FamilyPersonPage");
const mockApi = vi.mocked(api);

// FamilyPersonPage is the /family/people/:id route (router.ts → familyPerson),
// rendered by App as <FamilyPersonPage id={route.id} />.

const base = (id: string, name: string, over: Partial<FamilyPerson> = {}): FamilyPerson => ({
  id,
  name,
  maidenName: null,
  gender: "unknown",
  birthDate: null,
  deathDate: null,
  birthplace: null,
  deathPlace: null,
  bio: null,
  portraitUrl: null,
  portraitItemId: null,
  galleryPersonId: null,
  tags: [],
  canEdit: false,
  ...over
});

const DAD = base("dad", "Ivan Petrov", { gender: "male", birthDate: "1925" });
const MUM = base("mum", "Olga Petrova", { gender: "female" });
const BROTHER = base("bro", "Petr Petrov", { gender: "male", birthDate: "1953" });
const GRANDPA = base("gpa", "Grandpa Petrov", { gender: "male" });
const GRANDMA = base("gma", "Grandma Petrova", { gender: "female" });
const HUSBAND = base("husband", "Sergei Ivanov", { gender: "male" });
const EX = base("ex", "Pavel Sidorov", { gender: "male" });
const SON = base("son", "Alexei Ivanov", { gender: "male", birthDate: "1975" });
const DAUGHTER = base("daughter", "Nina Ivanova", { gender: "female", birthDate: "1978" });

const LONG_NOTE = "Moved for her husband's work. ".repeat(10).trim();

const unionDetail = (over: Partial<FamilyUnionDetail>): FamilyUnionDetail => ({
  id: "u",
  status: "married",
  marriedDate: null,
  marriedPlace: null,
  divorcedDate: null,
  note: null,
  partner: null,
  children: [],
  ...over
});

function profile(over: Partial<FamilyPersonProfile> = {}): FamilyPersonProfile {
  return {
    ...base("me", "Maria Ivanova", {
      gender: "female",
      maidenName: "Petrova",
      birthDate: "1950-06-15",
      birthplace: "Minsk",
      tags: ["Ivanovs"],
      bio: "Taught school for forty years."
    }),
    parents: [DAD, MUM],
    parentRelation: "biological",
    unions: [
      unionDetail({ id: "u-old", status: "divorced", marriedDate: "1968", divorcedDate: "1970", partner: EX }),
      unionDetail({
        id: "u-now",
        status: "married",
        marriedDate: "1972-08-01",
        marriedPlace: "Minsk",
        partner: HUSBAND,
        children: [
          { ...SON, relation: "biological" },
          { ...DAUGHTER, relation: "adopted" }
        ]
      })
    ],
    events: [
      { id: "e-work", personId: "me", type: "occupation", label: "Teacher", date: "1972", endDate: null, place: "School 5", note: null, photos: [] },
      { id: "e-home", personId: "me", type: "residence", label: null, date: "1990", endDate: "2000", place: "Gomel", note: LONG_NOTE, photos: [] }
    ],
    citations: [
      { id: "c-birth", sourceId: "s1", sourceTitle: "Parish register", sourceUrl: null, personId: "me", eventId: null, unionId: null, fact: "birth", detail: "Page 12", url: "https://example.org/rec/1", note: null },
      { id: "c-work", sourceId: "s2", sourceTitle: "Work book", sourceUrl: null, personId: "me", eventId: "e-work", unionId: null, fact: null, detail: null, url: null, note: null }
    ],
    galleryPerson: null,
    ...over
  };
}

const TREE: FamilyTree = {
  persons: [base("me", "Maria Ivanova"), DAD, MUM, BROTHER, GRANDPA, GRANDMA, HUSBAND, EX, SON, DAUGHTER],
  unions: [
    { id: "u-par", person1Id: "dad", person2Id: "mum", status: "married", marriedDate: null, marriedPlace: null, divorcedDate: null, note: null },
    { id: "u-gp", person1Id: "gpa", person2Id: "gma", status: "married", marriedDate: null, marriedPlace: null, divorcedDate: null, note: null }
  ],
  children: [
    { unionId: "u-par", childId: "me", relation: "biological" },
    { unionId: "u-par", childId: "bro", relation: "biological" },
    { unionId: "u-gp", childId: "dad", relation: "biological" }
  ],
  access: { isAdmin: false, canAdd: false },
  defaultPersonId: null
};

const photo = (n: number, attached = true): FamilyPhoto =>
  ({ id: `ph${n}`, title: `Photo ${n}`, kind: "photo", coverUrl: `/api/library/covers/ph${n}`, attached }) as unknown as FamilyPhoto;

const admin = { id: "u-admin", role: "admin" } as unknown as PublicUser;
const member = { id: "u-member", role: "user" } as unknown as PublicUser;

function mount({
  person = profile(),
  tree = TREE,
  photos = [] as FamilyPhoto[],
  photoTotal = photos.length,
  user = member,
  id = "me"
}: { person?: FamilyPersonProfile; tree?: FamilyTree; photos?: FamilyPhoto[]; photoTotal?: number; user?: PublicUser; id?: string } = {}) {
  const calls: { path: string; method: string }[] = [];
  mockApi.mockImplementation(async (path: string, options?: RequestInit) => {
    calls.push({ path, method: options?.method ?? "GET" });
    if (options?.method === "DELETE") return {} as never;
    if (path === `/api/family-tree/persons/${id}`) return { person } as never;
    if (path === "/api/family-tree/tree") return tree as never;
    if (path.startsWith(`/api/family-tree/persons/${id}/photos`)) return { assets: photos, total: photoTotal } as never;
    if (path === "/api/family-tree/settings") return { galleryLibrary: null, uploadFolder: null, canUpload: false, isAdmin: false } as never;
    if (path.startsWith("/api/library/quotes?")) return { quotes: [] } as never;
    throw new Error(`unexpected ${path}`);
  });
  const view = renderSignedIn(<FamilyPersonPage id={id} />, { user });
  return { calls, view };
}

const tabs = () => within(screen.getByRole("tablist", { name: "Person detail sections" }));
const openTab = async (name: string) => {
  await userEvent.click(tabs().getByRole("tab", { name }));
};
const metaValue = (term: string) => screen.getByText(term, { selector: "dt" }).nextElementSibling;
// The relationship tree's cards, keyed by name, reading what the card says.
const relationCard = (name: string) => screen.getByText(name, { selector: ".ft-relation-card strong" }).closest(".ft-relation-card")!;

beforeEach(() => {
  mockApi.mockReset();
  navigate.mockReset();
});

describe("FamilyPersonPage — header", () => {
  it("shows the person's name, née name, years, living status and age", async () => {
    mount();
    expect(await screen.findByRole("heading", { level: 1, name: "Maria Ivanova" })).toBeInTheDocument();
    expect(screen.getByText(/^née Petrova · 1950– · Living · Age \d+$/)).toBeInTheDocument();
  });

  it("lists birth, birthplace, gender, current relationship and family tags", async () => {
    mount();
    await screen.findByRole("heading", { level: 1, name: "Maria Ivanova" });
    expect(metaValue("Born")).toHaveTextContent("Jun 15, 1950");
    expect(metaValue("Birthplace")).toHaveTextContent("Minsk");
    expect(metaValue("Gender")).toHaveTextContent("Female");
    // The divorce is over; the current marriage is the one named.
    expect(metaValue("Relationship")).toHaveTextContent("Married to Sergei Ivanov");
    expect(screen.getByRole("link", { name: "Ivanovs" })).toHaveAttribute("href", "/family/people");
  });

  it("says Deceased and stops the age at the death date", async () => {
    mount({ person: profile({ birthDate: "1900-03-10", deathDate: "1950-03-09" }) });
    // One day short of the 50th birthday.
    expect(await screen.findByText("née Petrova · 1900–1950 · Deceased · Age 49")).toBeInTheDocument();
  });

  it("names a past partner when there is no current one", async () => {
    mount({
      person: profile({ unions: [unionDetail({ id: "u-w", status: "widowed", partner: HUSBAND })] })
    });
    await screen.findByRole("heading", { level: 1, name: "Maria Ivanova" });
    expect(metaValue("Relationship")).toHaveTextContent("Widowed from Sergei Ivanov");
  });

  it("links to the person in the chart", async () => {
    mount();
    expect(await screen.findByRole("link", { name: "View in tree" })).toHaveAttribute("href", "/family/tree/me");
  });
});

describe("FamilyPersonPage — tabs", () => {
  it("opens on Relationships and switches panels on click", async () => {
    mount();
    await screen.findByRole("heading", { level: 1, name: "Maria Ivanova" });
    expect(tabs().getAllByRole("tab").map((b) => b.textContent)).toEqual([
      "Relationships", "Timeline", "Photos", "Sources", "Biography", "Quotes"
    ]);
    // The chosen tab says so to a screen reader, not only by its underline.
    expect(tabs().getByRole("tab", { name: "Relationships", selected: true })).toHaveClass("active");
    expect(tabs().getAllByRole("tab", { selected: true })).toHaveLength(1);
    expect(screen.getByText("Parents")).toBeInTheDocument();

    await openTab("Biography");
    expect(tabs().getByRole("tab", { name: "Biography", selected: true })).toHaveClass("active");
    expect(tabs().getByRole("tab", { name: "Relationships", selected: false })).not.toHaveClass("active");
    expect(screen.getByText("Taught school for forty years.")).toBeInTheDocument();
    expect(screen.queryByText("Parents")).not.toBeInTheDocument();
  });

  it("returns to Relationships when the page moves to another person", async () => {
    const { view } = mount();
    await screen.findByRole("heading", { level: 1, name: "Maria Ivanova" });
    await openTab("Sources");
    expect(screen.getByText("Parish register")).toBeInTheDocument();

    const other = profile({ id: "bro", name: "Petr Petrov", maidenName: null, parents: [], unions: [] });
    mockApi.mockImplementation(async (path: string) => {
      if (path === "/api/family-tree/persons/bro") return { person: other } as never;
      if (path === "/api/family-tree/tree") return TREE as never;
      if (path.startsWith("/api/family-tree/persons/bro/photos")) return { assets: [], total: 0 } as never;
      throw new Error(`unexpected ${path}`);
    });
    // rerender swaps the whole tree, so the session goes back around it.
    view.rerender(
      <SessionContext.Provider value={{ user: member, logout: async () => {}, isAdminSession: false }}>
        <FamilyPersonPage id="bro" />
      </SessionContext.Provider>
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Petr Petrov" })).toBeInTheDocument();
    expect(tabs().getByRole("tab", { name: "Relationships", selected: true })).toHaveClass("active");
  });

  it("walks the tabs with the arrow keys and opens one with Enter", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { level: 1, name: "Maria Ivanova" });
    tabs().getByRole("tab", { name: "Relationships" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(tabs().getByRole("tab", { name: "Timeline" })).toHaveFocus();
    // Focus only — the panel stays until the tab is chosen.
    expect(tabs().getByRole("tab", { name: "Relationships", selected: true })).toBeInTheDocument();
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(tabs().getByRole("tab", { name: "Quotes" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(tabs().getByRole("tab", { name: "Relationships" })).toHaveFocus();
    await user.keyboard("{End}{Enter}");
    expect(tabs().getByRole("tab", { name: "Quotes", selected: true })).toBeInTheDocument();
  });
});

describe("FamilyPersonPage — Relationships", () => {
  it("lays relatives out by generation, each card saying what they are to this person", async () => {
    mount();
    await screen.findByRole("heading", { level: 1, name: "Maria Ivanova" });

    // Grandparents are grouped under the parent they came through.
    expect(screen.getByText("via Ivan Petrov")).toBeInTheDocument();
    expect(relationCard("Grandpa Petrov")).toHaveTextContent("Grandfather");
    expect(relationCard("Grandma Petrova")).toHaveTextContent("Grandmother");

    expect(relationCard("Ivan Petrov")).toHaveTextContent("Father");
    expect(relationCard("Olga Petrova")).toHaveTextContent("Mother");
    expect(relationCard("Petr Petrov")).toHaveTextContent("Brother");
    expect(screen.getByText("This person, partners and siblings")).toBeInTheDocument();

    // The current partner is marked as such; a divorced one is only a Partner.
    expect(relationCard("Sergei Ivanov")).toHaveTextContent(/Husband.*Current · Married · since Aug 1, 1972/);
    expect(relationCard("Pavel Sidorov")).toHaveTextContent(/Partner.*Divorced · 1968 – 1970/);

    expect(relationCard("Alexei Ivanov")).toHaveTextContent("Son");
    // Biological goes unsaid; anything else is spelled out.
    expect(relationCard("Nina Ivanova")).toHaveTextContent(/Daughter.*Adopted/);
  });

  it("links every relative to their own profile, and marks this person as the current page", async () => {
    mount();
    await screen.findByRole("heading", { level: 1, name: "Maria Ivanova" });
    expect(relationCard("Ivan Petrov")).toHaveAttribute("href", "/family/people/dad");
    await userEvent.click(relationCard("Nina Ivanova"));
    expect(navigate).toHaveBeenCalledWith("/family/people/daughter");

    const self = document.querySelector('[aria-current="page"]');
    expect(self).toHaveTextContent("Maria Ivanova");
    expect(self?.tagName).not.toBe("A");
  });

  it("puts the current partner first", async () => {
    mount();
    await screen.findByRole("heading", { level: 1, name: "Maria Ivanova" });
    const names = [...document.querySelectorAll(".ft-tree-self-row .ft-relation-card strong")].map((el) => el.textContent);
    expect(names).toEqual(["Petr Petrov", "Maria Ivanova", "Sergei Ivanov", "Pavel Sidorov"]);
  });

  it("says nobody is recorded instead of drawing empty rows", async () => {
    mount({
      person: profile({ parents: [], unions: [] }),
      tree: { ...TREE, children: [] }
    });
    expect(await screen.findByText("No relatives recorded yet.")).toBeInTheDocument();
    expect(screen.queryByText("Parents")).not.toBeInTheDocument();
    expect(screen.queryByText("Children")).not.toBeInTheDocument();
  });

  it("hints at Add relative to an editor", async () => {
    mount({ person: profile({ parents: [], unions: [], canEdit: true }), tree: { ...TREE, children: [] } });
    expect(await screen.findByText("No relatives recorded yet. Use Add relative above to start.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add relative/ })).toBeInTheDocument();
  });

  it("lets an admin remove a union only after confirming, then reloads the profile", async () => {
    const user = userEvent.setup();
    const { calls } = mount({ user: admin, person: profile({ canEdit: true }) });
    await screen.findByRole("heading", { level: 1, name: "Maria Ivanova" });

    const removeButtons = screen.getAllByRole("button", { name: "Remove this union" });
    expect(removeButtons).toHaveLength(2);
    await user.click(removeButtons[1]);
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("Remove this union?")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    const before = calls.filter((c) => c.path === "/api/family-tree/persons/me").length;
    await user.click(within(dialog).getByRole("button", { name: "Remove union" }));
    await waitFor(() => expect(calls).toContainEqual({ path: "/api/family-tree/unions/u-old", method: "DELETE" }));
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/family-tree/persons/me").length).toBe(before + 1));
  });
});

describe("FamilyPersonPage — Timeline", () => {
  it("merges birth, unions, children and events into one dated list, oldest first", async () => {
    mount();
    await screen.findByRole("heading", { level: 1, name: "Maria Ivanova" });
    await openTab("Timeline");

    const rows = within(document.querySelector("ol.ft-timeline") as HTMLElement).getAllByRole("listitem");
    const titles = rows.map((row) => row.querySelector("strong")?.textContent);
    expect(titles).toEqual([
      "Born",
      "Married Pavel Sidorov",
      "Divorced Pavel Sidorov",
      "Teacher",
      "Married Sergei Ivanov",
      "Birth of son Alexei Ivanov",
      "Birth of adopted daughter Nina Ivanova",
      "Residence"
    ]);
    // An event with its own label names its type underneath, with the place.
    expect(within(rows[3]).getByText("Work · School 5")).toBeInTheDocument();
    expect(within(rows[7]).getByText("1990–2000")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Minsk")).toBeInTheDocument();
  });

  it("clamps a long note behind More, and opens it", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { level: 1, name: "Maria Ivanova" });
    await openTab("Timeline");

    const note = screen.getByText(LONG_NOTE);
    expect(note).toHaveClass("is-clamped");
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(note).not.toHaveClass("is-clamped");
    await user.click(screen.getByRole("button", { name: "Less" }));
    expect(note).toHaveClass("is-clamped");
  });

  it("offers editing only on real events, and only to an editor", async () => {
    mount({ person: profile({ canEdit: true }) });
    await screen.findByRole("heading", { level: 1, name: "Maria Ivanova" });
    await openTab("Timeline");
    expect(screen.getByRole("button", { name: /Add event/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit Teacher" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Residence" })).toBeInTheDocument();
    // Birth and marriages are edited through the person and union, not here.
    expect(screen.queryByRole("button", { name: "Edit Born" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete Married Sergei Ivanov" })).not.toBeInTheDocument();
  });

  it("deletes an event after confirming", async () => {
    const user = userEvent.setup();
    const { calls } = mount({ person: profile({ canEdit: true }) });
    await screen.findByRole("heading", { level: 1, name: "Maria Ivanova" });
    await openTab("Timeline");
    await user.click(screen.getByRole("button", { name: "Delete Teacher" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText('Delete "Teacher"?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete event" }));
    await waitFor(() => expect(calls).toContainEqual({ path: "/api/family-tree/events/e-work", method: "DELETE" }));
  });

  it("says there is nothing yet when nothing is dated", async () => {
    mount({ person: profile({ birthDate: null, birthplace: null, unions: [], events: [] }) });
    await screen.findByRole("heading", { level: 1, name: "Maria Ivanova" });
    await openTab("Timeline");
    expect(screen.getByText("No events yet")).toBeInTheDocument();
  });
});

describe("FamilyPersonPage — Photos, Sources, Biography, Quotes", () => {
  it("previews twelve photos and links to the rest", async () => {
    mount({ photos: Array.from({ length: 15 }, (_, i) => photo(i + 1)), photoTotal: 15 });
    await screen.findByRole("heading", { level: 1, name: "Maria Ivanova" });
    await openTab("Photos");
    expect(screen.getAllByRole("img", { name: /^Photo \d+$/ })).toHaveLength(12);
    expect(screen.getByRole("link", { name: /View all 15 photos/ })).toHaveAttribute("href", "/family/people/me/photos");
  });

  it("shows the empty state with no photos, and no remove buttons to a viewer", async () => {
    mount();
    await screen.findByRole("heading", { level: 1, name: "Maria Ivanova" });
    await openTab("Photos");
    expect(screen.getByText("No photos yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add photos/ })).not.toBeInTheDocument();
  });

  it("lets an editor detach only the photos attached by hand", async () => {
    const user = userEvent.setup();
    const { calls } = mount({ person: profile({ canEdit: true }), photos: [photo(1, true), photo(2, false)] });
    await screen.findByRole("heading", { level: 1, name: "Maria Ivanova" });
    await openTab("Photos");
    const remove = screen.getAllByRole("button", { name: "Remove from this person" });
    // The face-matched photo isn't attached here, so there's nothing to detach.
    expect(remove).toHaveLength(1);
    await user.click(remove[0]);
    await waitFor(() => expect(calls).toContainEqual({ path: "/api/family-tree/persons/me/photos/ph1", method: "DELETE" }));
    await waitFor(() => expect(screen.queryByRole("img", { name: "Photo 1" })).not.toBeInTheDocument());
    expect(screen.getByRole("img", { name: "Photo 2" })).toBeInTheDocument();
  });

  it("lists sources with what each one supports", async () => {
    mount();
    await screen.findByRole("heading", { level: 1, name: "Maria Ivanova" });
    await openTab("Sources");
    const rows = document.querySelectorAll(".ft-citation-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText("Birth")).toBeInTheDocument();
    const link = within(rows[0] as HTMLElement).getByRole("link", { name: /Parish register/ });
    expect(link).toHaveAttribute("href", "https://example.org/rec/1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(within(rows[0] as HTMLElement).getByText("Page 12")).toBeInTheDocument();
    // A citation on an event names the event and its year.
    expect(within(rows[1] as HTMLElement).getByText("Teacher (1972)")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).queryByRole("link")).not.toBeInTheDocument();
  });

  it("shows the biography's empty state", async () => {
    mount({ person: profile({ bio: null }) });
    await screen.findByRole("heading", { level: 1, name: "Maria Ivanova" });
    await openTab("Biography");
    expect(screen.getByText("No biography yet")).toBeInTheDocument();
  });

  it("loads this person's quotes only when the tab is opened", async () => {
    const { calls } = mount();
    await screen.findByRole("heading", { level: 1, name: "Maria Ivanova" });
    expect(calls.some((c) => c.path.startsWith("/api/library/quotes"))).toBe(false);
    await openTab("Quotes");
    expect(await screen.findByText("Nothing recorded that Maria Ivanova said yet.")).toBeInTheDocument();
    expect(calls).toContainEqual({ path: "/api/library/quotes?personId=me", method: "GET" });
  });
});

describe("FamilyPersonPage — permissions and missing people", () => {
  it("gives a viewer a read-only page", async () => {
    mount({ user: member, person: profile({ canEdit: false }) });
    await screen.findByRole("heading", { level: 1, name: "Maria Ivanova" });
    expect(screen.queryByRole("button", { name: "Edit person" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete person" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change portrait" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add relative/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit relationship with/ })).not.toBeInTheDocument();
    // Sending to someone is reading, not editing.
    expect(screen.getByRole("button", { name: "Send to" })).toBeInTheDocument();
  });

  it("lets a branch editor edit but keeps deleting and unlinking for admins", async () => {
    mount({ user: member, person: profile({ canEdit: true }) });
    await screen.findByRole("heading", { level: 1, name: "Maria Ivanova" });
    expect(screen.getByRole("button", { name: "Edit person" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit relationship with Sergei Ivanov" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete person" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove this union" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove .* from this family/ })).not.toBeInTheDocument();
  });

  it("deletes the person after a named confirmation and returns to People", async () => {
    const user = userEvent.setup();
    const { calls } = mount({ user: admin, person: profile({ canEdit: true }) });
    await screen.findByRole("heading", { level: 1, name: "Maria Ivanova" });
    await user.click(screen.getByRole("button", { name: "Delete person" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText('Delete "Maria Ivanova"?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete person" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/family/people"));
    expect(calls).toContainEqual({ path: "/api/family-tree/persons/me", method: "DELETE" });
  });

  it("says the person is gone on a 404, with a way back", async () => {
    mockApi.mockImplementation(async (path: string) => {
      if (path === "/api/family-tree/persons/gone") throw new ApiError("Not found", 404);
      if (path === "/api/family-tree/tree") return TREE as never;
      if (path.startsWith("/api/family-tree/persons/gone/photos")) return { assets: [], total: 0 } as never;
      if (path === "/api/family-tree/settings") return {} as never;
      throw new Error(`unexpected ${path}`);
    });
    renderSignedIn(<FamilyPersonPage id="gone" />, { user: member });
    expect(await screen.findByText("Person not found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to family members" })).toHaveAttribute("href", "/family/people");
  });

  it("reports any other load failure as an error", async () => {
    mockApi.mockImplementation(async (path: string) => {
      if (path === "/api/family-tree/persons/me") throw new ApiError("Database locked", 500);
      if (path === "/api/family-tree/tree") return TREE as never;
      if (path.startsWith("/api/family-tree/persons/me/photos")) return { assets: [], total: 0 } as never;
      if (path === "/api/family-tree/settings") return {} as never;
      throw new Error(`unexpected ${path}`);
    });
    renderSignedIn(<FamilyPersonPage id="me" />, { user: member });
    expect(await screen.findByText("Database locked")).toBeInTheDocument();
    expect(screen.getByText("Unable to load")).toBeInTheDocument();
    expect(screen.queryByText("Person not found")).not.toBeInTheDocument();
  });
});
