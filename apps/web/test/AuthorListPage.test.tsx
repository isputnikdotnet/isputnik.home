import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn() }));
vi.mock("../src/app/DashboardShell", () => ({
  DashboardShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}));
const navigate = vi.fn();
const replaceQuery = vi.fn();
vi.mock("../src/router", () => ({
  navigate: (...args: unknown[]) => navigate(...args),
  queryParam: () => null,
  replaceQuery: (...args: unknown[]) => replaceQuery(...args)
}));

const { api } = await import("../src/api");
const { AuthorListPage } = await import("../src/features/audiobooks/AuthorListPage");
const mockApi = vi.mocked(api);

// The Authors browse is one list over every media type, so its filters are the
// only way to get to a name. These cover what the page itself decides: which of
// the server's two indexes the First/Last choice selects, and how the media-type,
// library and A–Z filters compose. Deriving the indexes — surnames, scripts,
// accents, the "#" bucket — belongs to the server (apps/server/test/alphabet.test.ts),
// so the fixtures below state them the way the API does.

type Author = {
  name: string;
  sortName: string | null;
  audiobookCount: number;
  ebookCount: number;
  libraryIds: string[];
  alphaKey: string;
  alphaKeyLast: string;
  sortKey: string;
  sortKeyLast: string;
};

// `indexes` is [first-name bucket, surname bucket]; the sort keys follow from the
// names, which is what the server does.
const author = (name: string, indexes: [string, string], over: Partial<Author> = {}): Author => {
  const surname = name.trim().split(/\s+/).filter((word) => !/^(jr\.?|sr\.?)$/i.test(word)).pop() ?? name;
  return {
    name,
    sortName: null,
    audiobookCount: 1,
    ebookCount: 0,
    libraryIds: ["lib-a"],
    alphaKey: indexes[0],
    alphaKeyLast: indexes[1],
    sortKey: name.toUpperCase(),
    sortKeyLast: surname.toUpperCase(),
    ...over
  };
};

const LIBRARIES = [
  { id: "lib-a", name: "Fiction", type: "audiobook" },
  { id: "lib-b", name: "Reference", type: "ebook" }
];

function mount(authors: Author[], libraries = LIBRARIES) {
  mockApi.mockImplementation(async (path: string) => {
    if (path === "/api/library/people/authors") return { authors, libraries };
    if (path === "/api/library/people/photos") return { photos: {} };
    throw new Error(`unexpected ${path}`);
  });
  return render(<AuthorListPage user={{ id: "u1" } as never} logout={async () => {}} />);
}

const cardNames = () =>
  screen.getAllByRole("button").map((b) => b.textContent ?? "").filter((t) => /\d+ titles?$/.test(t));

// "#" is labelled in words for screen readers, so it can't be found by its glyph.
const letter = (value: string) =>
  within(screen.getByRole("group", { name: /Filter by (first|last) letter/ })).getByRole("button", {
    name: value === "#" ? "Starting with a number or symbol" : value
  });

beforeEach(() => {
  mockApi.mockReset();
  navigate.mockReset();
  replaceQuery.mockReset();
});

describe("Authors browse filters", () => {
  it("indexes by first name until asked for last, then re-files and re-sorts", async () => {
    const user = userEvent.setup();
    mount([
      author("Ursula K. Le Guin", ["U", "G"]),
      author("Terry Pratchett", ["T", "P"]),
      author("Isaac Asimov", ["I", "A"])
    ]);
    await screen.findByText("Isaac Asimov");

    // First-name order: Isaac, Terry, Ursula.
    expect(cardNames().map((t) => t.split(/\d/)[0].trim())).toEqual([
      "Isaac Asimov",
      "Terry Pratchett",
      "Ursula K. Le Guin"
    ]);
    // …and U is the letter that finds Ursula.
    await user.click(letter("U"));
    expect(cardNames()).toHaveLength(1);
    expect(screen.getByText("Ursula K. Le Guin")).toBeInTheDocument();

    // The sort control is shared/SortMenu — the same box the Audiobooks page uses,
    // so its options are menu items in a portalled menu.
    await user.click(screen.getByRole("button", { name: /^Sort and index by:/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Last name" }));

    // Same person now files under G (Guin), so the U selection empties…
    await waitFor(() => expect(screen.getByRole("heading", { name: /No authors match/ })).toBeInTheDocument());
    await user.click(letter("G"));
    expect(screen.getByText("Ursula K. Le Guin")).toBeInTheDocument();

    // …and the order is by surname: Asimov, Le Guin, Pratchett.
    await user.click(letter("All"));
    expect(cardNames().map((t) => t.split(/\d/)[0].trim())).toEqual([
      "Isaac Asimov",
      "Ursula K. Le Guin",
      "Terry Pratchett"
    ]);
  });

  it("shows the # bucket the server filed a name under", async () => {
    const user = userEvent.setup();
    mount([author("Ángela Vallvey", ["A", "V"]), author("50 Cent", ["#", "#"])]);
    await screen.findByText("Ángela Vallvey");

    await user.click(letter("A"));
    expect(cardNames()).toHaveLength(1);
    expect(screen.getByText("Ángela Vallvey")).toBeInTheDocument();

    await user.click(letter("#"));
    expect(cardNames()).toHaveLength(1);
    expect(screen.getByText("50 Cent")).toBeInTheDocument();
  });

  it("offers the Cyrillic alphabet only once a name is filed under one", async () => {
    const user = userEvent.setup();
    mount([author("Isaac Asimov", ["I", "A"])]);
    await screen.findByText("Isaac Asimov");
    // One script in the list, so there is nothing to toggle between.
    expect(screen.queryByRole("group", { name: "Alphabet" })).not.toBeInTheDocument();

    mockApi.mockReset();
    mount([author("Isaac Asimov", ["I", "A"]), author("Лев Толстой", ["Л", "Т"])]);
    await screen.findAllByText("Лев Толстой");
    await user.click(screen.getAllByRole("button", { name: "Русский" })[0]);
    expect(screen.getAllByRole("button", { name: "Л" })[0]).toBeEnabled();
  });

  it("greys out letters nothing is filed under, and keeps them in place", async () => {
    mount([author("Isaac Asimov", ["I", "A"])]);
    await screen.findByText("Isaac Asimov");

    expect(letter("I")).toBeEnabled();
    expect(letter("Q")).toBeDisabled();
    // Disabled, not removed — the row must not reflow as filters change.
    expect(letter("Q")).toBeInTheDocument();
  });

  it("narrows to one library, and offers no library picker when there is only one", async () => {
    const user = userEvent.setup();
    mount([
      author("Isaac Asimov", ["I", "A"], { libraryIds: ["lib-a"] }),
      author("Donald Knuth", ["D", "K"], { libraryIds: ["lib-b"], audiobookCount: 0, ebookCount: 3 })
    ]);
    await screen.findByText("Isaac Asimov");

    await user.click(screen.getByRole("button", { name: "Library" }));
    await user.click(await screen.findByRole("menuitem", { name: "Reference" }));

    await waitFor(() => expect(screen.queryByText("Isaac Asimov")).not.toBeInTheDocument());
    expect(screen.getByText("Donald Knuth")).toBeInTheDocument();

    // The letter strip follows the library, not the other way round.
    expect(letter("I")).toBeDisabled();
    expect(letter("D")).toBeEnabled();
  });

  it("hides the library picker when there is nothing to choose between", async () => {
    mount([author("Isaac Asimov", ["I", "A"])], [LIBRARIES[0]]);
    await screen.findByText("Isaac Asimov");
    expect(screen.queryByRole("button", { name: "Library" })).not.toBeInTheDocument();
  });

  it("counts titles for the media type in view", async () => {
    const user = userEvent.setup();
    mount([author("Isaac Asimov", ["I", "A"], { audiobookCount: 2, ebookCount: 5 })]);
    await screen.findByText("Isaac Asimov");
    expect(screen.getByText("7 titles")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Ebooks/ }));
    expect(screen.getByText("5 titles")).toBeInTheDocument();
  });
});
