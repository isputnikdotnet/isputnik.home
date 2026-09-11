import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "../src/api";
import type { FamilyPerson } from "../src/features/familytree/types";
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
// The page's contract with its dialogs is what it hands them and what it does
// with their answer; the dialogs themselves are someone else's tests.
vi.mock("../src/features/familytree/BulkTagPeopleModal", () => ({
  BulkTagPeopleModal: ({ persons, onSaved }: { persons: FamilyPerson[]; onSaved: (p: FamilyPerson[]) => void }) => (
    <div role="dialog" aria-label="Bulk tags">
      <ul>{persons.map((p) => <li key={p.id}>{p.name}</li>)}</ul>
      <button type="button" onClick={() => onSaved(persons.map((p) => ({ ...p, tags: [...p.tags, "Smiths"] })))}>
        Stub save tags
      </button>
    </div>
  )
}));
vi.mock("../src/features/familytree/PersonEditModal", () => ({
  PersonEditModal: ({ person, showTags, onSaved }: { person: FamilyPerson | null; showTags: boolean; onSaved: (p: FamilyPerson) => void }) => (
    <div role="dialog" aria-label={person ? "Edit person" : "New person"} data-show-tags={String(showTags)}>
      <button type="button" onClick={() => onSaved({ id: "new-1" } as FamilyPerson)}>Stub save person</button>
    </div>
  )
}));
vi.mock("../src/features/familytree/FamilyTreeSettingsModal", () => ({
  FamilyTreeSettingsModal: () => <div role="dialog" aria-label="Tree settings stub" />
}));

const { api } = await import("../src/api");
const { FamilyPeoplePage } = await import("../src/features/familytree/FamilyPeoplePage");
const mockApi = vi.mocked(api);

const person = (id: string, name: string, over: Partial<FamilyPerson> = {}): FamilyPerson => ({
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

const PEOPLE = [
  person("p1", "Anna Petrova", { maidenName: "Ivanova", birthDate: "1931-02-03", deathDate: "2010", tags: ["Petrovs"] }),
  person("p2", "Boris Petrov", { birthDate: "1929", tags: ["Petrovs"] }),
  person("p3", "Clara Smith", { tags: ["Smiths", "Petrovs"] }),
  person("p4", "David Jones")
];

const admin = { id: "u-admin", role: "admin" } as unknown as PublicUser;
const member = { id: "u-member", role: "user" } as unknown as PublicUser;

function mount({
  persons = PEOPLE,
  canAdd = true,
  user = member
}: { persons?: FamilyPerson[]; canAdd?: boolean; user?: PublicUser } = {}) {
  mockApi.mockImplementation(async (path: string) => {
    if (path === "/api/family-tree/persons") return { persons, access: { isAdmin: user.role === "admin", canAdd } } as never;
    throw new Error(`unexpected ${path}`);
  });
  return renderSignedIn(<FamilyPeoplePage />, { user });
}

const cardLinks = () =>
  screen.queryAllByRole("link").filter((a) => a.getAttribute("href")?.startsWith("/family/people/"));
const cardNames = () => cardLinks().map((a) => within(a).getByText((_, el) => el?.tagName === "STRONG").textContent);
const search = () => screen.getByRole("searchbox", { name: "Search family members..." });
const tagChip = (name: RegExp) =>
  within(screen.getByRole("group", { name: "Filter by family tag" })).getByRole("button", { name });

beforeEach(() => {
  mockApi.mockReset();
  navigate.mockReset();
});

describe("FamilyPeoplePage — the grid", () => {
  it("lists everyone as a link to their profile, with née name and life years", async () => {
    mount();
    await screen.findByText("Anna Petrova");
    expect(cardNames()).toEqual(["Anna Petrova", "Boris Petrov", "Clara Smith", "David Jones"]);
    const anna = cardLinks().find((a) => a.textContent?.includes("Anna Petrova"))!;
    expect(anna).toHaveAttribute("href", "/family/people/p1");
    expect(within(anna).getByText("née Ivanova · 1931–2010")).toBeInTheDocument();
    // Only a birth year still reads as an open range.
    expect(screen.getByText("1929–")).toBeInTheDocument();
    expect(screen.getByText("4 people")).toBeInTheDocument();
  });

  it("opens the profile in place when a card is clicked", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByText("Boris Petrov"));
    expect(navigate).toHaveBeenCalledWith("/family/people/p2");
  });

  it("searches names and maiden names, ignoring case, and says so when nothing matches", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("Anna Petrova");

    await user.type(search(), "PETROV");
    expect(cardNames()).toEqual(["Anna Petrova", "Boris Petrov"]);
    expect(screen.getByText("2 people")).toBeInTheDocument();

    // A maiden name finds her too.
    await user.clear(search());
    await user.type(search(), "ivanova");
    expect(cardNames()).toEqual(["Anna Petrova"]);
    expect(screen.getByText("1 person")).toBeInTheDocument();

    await user.clear(search());
    await user.type(search(), "zzz");
    expect(cardNames()).toEqual([]);
    expect(screen.getByText("No one matches your search.")).toBeInTheDocument();
  });

  it("offers a chip per family tag, counted from the people loaded, and filters by it", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("Anna Petrova");

    const chips = within(screen.getByRole("group", { name: "Filter by family tag" })).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual(["Petrovs · 3", "Smiths · 1"]);

    await user.click(tagChip(/^Smiths/));
    expect(tagChip(/^Smiths/)).toHaveAttribute("aria-pressed", "true");
    expect(cardNames()).toEqual(["Clara Smith"]);

    // Choosing another tag replaces the filter rather than adding to it.
    await user.click(tagChip(/^Petrovs/));
    expect(tagChip(/^Smiths/)).toHaveAttribute("aria-pressed", "false");
    expect(cardNames()).toEqual(["Anna Petrova", "Boris Petrov", "Clara Smith"]);

    // Clicking the active chip again clears it.
    await user.click(tagChip(/^Petrovs/));
    expect(cardNames()).toHaveLength(4);
  });

  it("combines the tag filter with the search", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("Anna Petrova");
    await user.click(tagChip(/^Petrovs/));
    await user.type(search(), "smith");
    expect(cardNames()).toEqual(["Clara Smith"]);
  });

  it("shows no tag strip when nobody carries a tag", async () => {
    mount({ persons: [person("p4", "David Jones")] });
    await screen.findByText("David Jones");
    expect(screen.queryByRole("group", { name: "Filter by family tag" })).not.toBeInTheDocument();
  });
});

describe("FamilyPeoplePage — empty and error states", () => {
  it("invites someone who may add to start the tree", async () => {
    mount({ persons: [], canAdd: true });
    expect(await screen.findByText("No family members yet. Add the first person to start the tree.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add person" })).toBeInTheDocument();
  });

  it("just says it is empty to someone who may not add, and offers no Add", async () => {
    mount({ persons: [], canAdd: false });
    expect(await screen.findByText("No family members yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add person" })).not.toBeInTheDocument();
  });

  it("reports a failed load in an error box", async () => {
    mockApi.mockRejectedValue(new Error("Server is down"));
    renderSignedIn(<FamilyPeoplePage />, { user: member });
    expect(await screen.findByText("Server is down")).toBeInTheDocument();
    expect(screen.getByText("Unable to load family members")).toBeInTheDocument();
  });
});

describe("FamilyPeoplePage — adding", () => {
  it("opens a blank person dialog and goes to the new person's page once saved", async () => {
    const user = userEvent.setup();
    mount({ user: member, canAdd: true });
    await user.click(await screen.findByRole("button", { name: "Add person" }));
    const dialog = screen.getByRole("dialog", { name: "New person" });
    // Tags are the permission scope, so only an admin sets them here.
    expect(dialog).toHaveAttribute("data-show-tags", "false");
    await user.click(within(dialog).getByRole("button", { name: "Stub save person" }));
    expect(navigate).toHaveBeenCalledWith("/family/people/new-1");
  });

  it("lets an admin set tags on a new person", async () => {
    const user = userEvent.setup();
    mount({ user: admin });
    await user.click(await screen.findByRole("button", { name: "Add person" }));
    expect(screen.getByRole("dialog", { name: "New person" })).toHaveAttribute("data-show-tags", "true");
  });
});

describe("FamilyPeoplePage — admin bulk tagging", () => {
  it("is not offered to members", async () => {
    mount({ user: member });
    await screen.findByText("Anna Petrova");
    expect(screen.queryByRole("button", { name: "Select" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Family tree settings" })).not.toBeInTheDocument();
  });

  it("turns cards into toggles while selecting, so a click picks instead of leaving the page", async () => {
    const user = userEvent.setup();
    mount({ user: admin });
    await screen.findByText("Anna Petrova");
    await user.click(screen.getByRole("button", { name: "Select" }));

    expect(cardLinks()).toHaveLength(0);
    const boris = screen.getByRole("button", { name: /Boris Petrov/ });
    expect(boris).toHaveAttribute("aria-pressed", "false");
    // Nothing chosen yet, so there is nothing to tag.
    expect(screen.getByRole("button", { name: "Tags" })).toBeDisabled();
    expect(screen.getByText("0 selected")).toBeInTheDocument();

    await user.click(boris);
    expect(boris).toHaveAttribute("aria-pressed", "true");
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tags" })).toBeEnabled();

    await user.click(boris);
    expect(boris).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("0 selected")).toBeInTheDocument();
  });

  it("selects everyone shown with All — not people hidden by the search", async () => {
    const user = userEvent.setup();
    mount({ user: admin });
    await screen.findByText("Anna Petrova");
    await user.click(screen.getByRole("button", { name: "Select" }));
    await user.type(search(), "petrov");
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tags" }));
    const dialog = screen.getByRole("dialog", { name: "Bulk tags" });
    expect(within(dialog).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Anna Petrova", "Boris Petrov"]);
  });

  it("applies the saved tags to the grid, leaves selection and says how many changed", async () => {
    const user = userEvent.setup();
    mount({ user: admin });
    await screen.findByText("Anna Petrova");
    await user.click(screen.getByRole("button", { name: "Select" }));
    await user.click(screen.getByRole("button", { name: /David Jones/ }));
    await user.click(screen.getByRole("button", { name: "Tags" }));
    await user.click(screen.getByRole("button", { name: "Stub save tags" }));

    expect(await screen.findByText("Family tags updated on 1 person.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Bulk tags" })).not.toBeInTheDocument();
    // Back to links, and David now counts toward the Smiths chip.
    await waitFor(() => expect(cardLinks()).toHaveLength(4));
    expect(tagChip(/^Smiths/)).toHaveTextContent("Smiths · 2");
  });

  it("clears the selection on Done", async () => {
    const user = userEvent.setup();
    mount({ user: admin });
    await screen.findByText("Anna Petrova");
    await user.click(screen.getByRole("button", { name: "Select" }));
    await user.click(screen.getByRole("button", { name: /Anna Petrova/ }));
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(cardLinks()).toHaveLength(4);

    // Coming back in starts from nothing.
    await user.click(screen.getByRole("button", { name: "Select" }));
    expect(screen.getByText("0 selected")).toBeInTheDocument();
  });
});
