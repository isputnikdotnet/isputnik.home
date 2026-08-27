import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn() }));
const { api } = await import("../src/api");
const { NotesSection } = await import("../src/features/social/NotesSection");
const mockApi = vi.mocked(api);

// The one rule this component must never break: a note is TEXT. It is rendered
// as a React child and never as markup, which is the whole XSS story for
// user-authored content in this app. Everything else here is ordinary UI.

interface Note {
  id: string;
  body: string;
  authorName: string;
  mine: boolean;
  createdAt: string;
  edited: boolean;
  canDelete: boolean;
}

const note = (over: Partial<Note> = {}): Note => ({
  id: "n1",
  body: "the middle drags",
  authorName: "Mum",
  mine: false,
  createdAt: new Date().toISOString(),
  edited: false,
  canDelete: false,
  ...over
});

/** Wire the mocked api: GET returns `notes`, POST echoes back what it was given. */
function mount(notes: Note[] = []) {
  const posted: string[] = [];
  mockApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as { body: string };
      posted.push(body.body);
      return { note: note({ id: `posted-${posted.length}`, body: body.body, mine: true, canDelete: true }) };
    }
    if (init?.method === "DELETE") return { ok: true };
    if (path.startsWith("/api/social/notes?")) return { notes };
    return {};
  });
  render(<NotesSection entityType="ebook" entityId="book-1" />);
  return { posted };
}

// A block body on purpose: `() => mockApi.mockReset()` RETURNS the mock, and
// vitest treats a returned function as a teardown callback — so it calls api()
// with no arguments after every test, which any mock implementation then has to
// survive. Easy to miss and confusing to debug.
beforeEach(() => {
  mockApi.mockReset();
});

describe("a note is text", () => {
  it("shows markup as the characters somebody typed, never as elements", async () => {
    const nasty = '<script>alert("x")</script> **not bold** <img src=x onerror=1>';
    mount([note({ body: nasty })]);

    const body = await screen.findByText(nasty);
    // The assertion that matters: no markup became DOM. If this ever fails
    // because somebody rendered notes richly, the security story changed with it.
    expect(body.querySelector("script")).toBeNull();
    expect(body.querySelector("img")).toBeNull();
    expect(body.children).toHaveLength(0);
    expect(document.querySelector("script")).toBeNull();
  });

  it("keeps the line breaks somebody typed", async () => {
    mount([note({ body: "first line\nsecond line" })]);
    const body = await screen.findByText(/first line/);
    expect(body.textContent).toBe("first line\nsecond line");
  });
});

describe("posting", () => {
  it("sends what was typed and shows it without a refetch", async () => {
    const user = userEvent.setup();
    const { posted } = mount([]);
    await screen.findByText("Nothing here yet. Say something about it.");

    await user.type(screen.getByPlaceholderText("Add a note…"), "what a trip");
    await user.click(screen.getByRole("button", { name: "Post" }));

    await waitFor(() => expect(posted).toEqual(["what a trip"]));
    expect(await screen.findByText("what a trip")).toBeInTheDocument();
    // Cleared, so the next thought does not land on top of the last one.
    expect(screen.getByPlaceholderText("Add a note…")).toHaveValue("");
  });

  it("will not post nothing", async () => {
    const user = userEvent.setup();
    mount([]);
    await screen.findByText("Nothing here yet. Say something about it.");

    expect(screen.getByRole("button", { name: "Post" })).toBeDisabled();
    await user.type(screen.getByPlaceholderText("Add a note…"), "   ");
    expect(screen.getByRole("button", { name: "Post" })).toBeDisabled();
  });
});

describe("who can remove what", () => {
  it("offers no bin on somebody else's note", async () => {
    mount([note({ authorName: "Mum", canDelete: false })]);
    await screen.findByText("the middle drags");
    expect(screen.queryByRole("button", { name: /Remove note/ })).not.toBeInTheDocument();
  });

  it("asks before removing, and says what does not change", async () => {
    const user = userEvent.setup();
    mount([note({ mine: true, canDelete: true })]);
    await screen.findByText("the middle drags");

    await user.click(screen.getByRole("button", { name: "Remove your note" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Remove this note?")).toBeInTheDocument();
    expect(within(dialog).getByText(/Nothing else about the item changes/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Remove note" }));
    await waitFor(() => expect(screen.queryByText("the middle drags")).not.toBeInTheDocument());
  });
});

describe("the emoji picker", () => {
  it("drops an emoji in at the cursor rather than on the end", async () => {
    const user = userEvent.setup();
    mount([]);
    await screen.findByText("Nothing here yet. Say something about it.");

    const field = screen.getByPlaceholderText("Add a note…") as HTMLTextAreaElement;
    await user.type(field, "Great trip");
    field.setSelectionRange(5, 5); // just after "Great"

    await user.click(screen.getByRole("button", { name: "Add an emoji" }));
    await user.click(screen.getByRole("button", { name: "🎉" }));

    expect(field).toHaveValue("Great🎉 trip");
  });

  it("closes on Escape without leaving anything behind", async () => {
    const user = userEvent.setup();
    mount([]);
    await screen.findByText("Nothing here yet. Say something about it.");

    await user.click(screen.getByRole("button", { name: "Add an emoji" }));
    expect(screen.getByRole("dialog", { name: "Emoji" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Emoji" })).not.toBeInTheDocument());
    expect(screen.getByPlaceholderText("Add a note…")).toHaveValue("");
  });
});
