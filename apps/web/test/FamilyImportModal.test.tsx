import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSignedIn } from "./helpers/session";
import { api } from "../src/api";
import { FamilyImportModal } from "../src/features/familytree/FamilyImportModal";

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("../src/features/familytree/PersonPickerModal", () => ({
  PersonPickerModal: ({ onPick }: { onPick: (p: { id: string }) => void }) => (
    <div role="dialog" aria-label="Pick a person">
      <button type="button" onClick={() => onPick({ id: "local-dima" })}>Stub pick Dima</button>
    </div>
  )
}));

// The package import: a zip goes up, the server's plan comes back as a preview,
// the admin decides per person, and only then is it written. The dialog's job is
// to show the plan faithfully and send the decisions back.

const anna = {
  id: "pkg-anna", name: "Anna Posse", birthDate: "1928", deathDate: null, hasPortrait: true, photos: 2,
  suggested: { localId: "local-anna", name: "Anna Posse", birthDate: "1928", deathDate: null, reason: "nameAndBirth" },
  match: { localId: "local-anna", name: "Anna Posse", birthDate: "1928", deathDate: null, reason: "nameAndBirth" },
  decision: { action: "merge", matchId: "local-anna" },
  differences: [{ field: "birthplace", here: "Minsk", package: "Мінск", resolution: "keepHere" }],
  fills: ["bio"]
};
const dmitri = {
  id: "pkg-dmitri", name: "Dmitri Posse", birthDate: "1955", deathDate: null, hasPortrait: false, photos: 0,
  suggested: null, match: null, decision: { action: "add" }, differences: [], fills: []
};
const summary = {
  personsCreated: 1, personsMatched: 1, personsFilled: 1, personsOverwritten: 0, personsSkipped: 0, personsRemoved: 0,
  unionsCreated: 0, childrenLinked: 0, eventsCreated: 0, sourcesCreated: 0, citationsCreated: 0,
  portraitsSet: 0, photosImported: 2, photosReused: 0, differences: 1
};
const preview = { mode: "migrate", persons: [anna, dmitri], summary, notCarried: ["galleryLinks", "branchEditors"], warnings: [] };
const upload = { token: "tok-1", package: { exportedAt: "2026-09-20T10:00:00Z", appVersion: "4.25.0", counts: { persons: 2 } }, preview };

const fetchMock = vi.fn();

beforeEach(() => {
  vi.mocked(api).mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue({ ok: true, json: async () => upload });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function openPreview() {
  const user = userEvent.setup();
  renderSignedIn(<FamilyImportModal personCount={3} onClose={() => {}} onImported={() => {}} />, { user: { id: "u1", role: "admin" } as never });
  const file = new File(["zip"], "family-tree-2026-09-20.zip", { type: "application/zip" });
  await user.upload(screen.getByLabelText("File"), file);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { name: "Import a family-tree package" });
  return user;
}

describe("FamilyImportModal — package preview", () => {
  it("uploads the zip and shows every person beside their match and the plan's tally", async () => {
    await openPreview();
    expect(fetchMock).toHaveBeenCalledWith("/api/family-tree/import/package", expect.objectContaining({ method: "POST" }));
    expect(screen.getByText("1 person added · 1 matched · 0 new families · 2 photos · 1 difference")).toBeInTheDocument();

    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    // Once for the package's Anna, once for the Anna here she was matched with.
    expect(within(rows[0]).getAllByText("Anna Posse", { selector: "strong" })).toHaveLength(2);
    expect(within(rows[0]).getByText(/same name and birth date/)).toBeInTheDocument();
    expect(within(rows[0]).getByRole("combobox", { name: "What to do with Anna Posse" })).toHaveValue("merge");
    expect(within(rows[0]).getByText(/Birthplace: here “Minsk”, in the package “Мінск”/)).toBeInTheDocument();
    expect(within(rows[0]).getByText("Fills in: Biography")).toBeInTheDocument();

    expect(within(rows[1]).getByText("New person")).toBeInTheDocument();
    expect(within(rows[1]).getByRole("combobox", { name: "What to do with Dmitri Posse" })).toHaveValue("add");
    // Someone new can be matched by hand; someone matched can be merged three ways or added anyway.
    expect(within(rows[1]).getByRole("button", { name: /Match with someone here/ })).toBeInTheDocument();
    expect(within(rows[0]).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Merge — fill in the blanks", "Use the package's values", "Keep as it is here", "Add as a new person", "Skip this person"
    ]);
    expect(screen.getByText("Not carried over")).toBeInTheDocument();
  });

  it("sends each decision back to be re-planned, and the whole set on import", async () => {
    const user = await openPreview();
    const replanned = { ...preview, persons: [{ ...anna, decision: { action: "usePackage", matchId: "local-anna" }, differences: [{ ...anna.differences[0], resolution: "usePackage" }] }, dmitri], summary: { ...summary, personsOverwritten: 1 } };
    vi.mocked(api).mockResolvedValueOnce({ preview: replanned });
    await user.selectOptions(screen.getByRole("combobox", { name: "What to do with Anna Posse" }), "usePackage");
    await waitFor(() => expect(api).toHaveBeenCalledWith("/api/family-tree/import/package/tok-1/preview", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ mode: "migrate", persons: { "pkg-anna": { action: "usePackage", matchId: "local-anna" } } })
    })));
    await screen.findByText(/the package's is taken/);

    // A manual match for the new person goes up as a merge with that person.
    vi.mocked(api).mockResolvedValueOnce({ preview: replanned });
    await user.click(screen.getByRole("button", { name: /Match with someone here/ }));
    await user.click(screen.getByRole("button", { name: "Stub pick Dima" }));
    await waitFor(() => expect(api).toHaveBeenLastCalledWith("/api/family-tree/import/package/tok-1/preview", expect.objectContaining({
      body: JSON.stringify({ mode: "migrate", persons: { "pkg-anna": { action: "usePackage", matchId: "local-anna" }, "pkg-dmitri": { action: "merge", matchId: "local-dima" } } })
    })));

    vi.mocked(api).mockResolvedValueOnce({ mode: "migrate", summary: { ...summary, personsCreated: 0, personsMatched: 2 }, warnings: ["One photo was left out."] });
    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(api).toHaveBeenLastCalledWith("/api/family-tree/import/package/tok-1/apply", expect.objectContaining({ method: "POST" })));
    expect(await screen.findByText("Added 0 people")).toBeInTheDocument();
    expect(screen.getByText("One photo was left out.")).toBeInTheDocument();
  });

  it("replace asks before it deletes, and the confirm carries the mode", async () => {
    const user = await openPreview();
    vi.mocked(api).mockResolvedValueOnce({ preview: { ...preview, mode: "replace", summary: { ...summary, personsRemoved: 3 } } });
    await user.click(screen.getByRole("radio", { name: /Replace the current tree/ }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/api/family-tree/import/package/tok-1/preview", expect.objectContaining({
      body: JSON.stringify({ mode: "replace", persons: {} })
    })));
    // No per-person table in Replace: everyone is created.
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Replace the current tree" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText("Replace the family tree?")).toBeInTheDocument();
    vi.mocked(api).mockResolvedValueOnce({ mode: "replace", summary: { ...summary, personsRemoved: 3, personsCreated: 2 }, warnings: [] });
    await user.click(within(confirm).getByRole("button", { name: "Replace and import" }));
    await waitFor(() => expect(api).toHaveBeenLastCalledWith("/api/family-tree/import/package/tok-1/apply", expect.objectContaining({
      body: JSON.stringify({ mode: "replace", persons: {} })
    })));
    expect(await screen.findByText("3 previous people were replaced.")).toBeInTheDocument();
  });

  it("a GEDCOM still goes the old way, as JSON", async () => {
    const user = userEvent.setup();
    renderSignedIn(<FamilyImportModal personCount={0} onClose={() => {}} onImported={() => {}} />, { user: { id: "u1", role: "admin" } as never });
    await user.upload(screen.getByLabelText("File"), new File(["0 HEAD"], "tree.ged"));
    vi.mocked(api).mockResolvedValueOnce({ personsCreated: 4, unionsCreated: 1, childrenLinked: 2, eventsCreated: 0, sourcesCreated: 0, citationsCreated: 0, personsRemoved: 0, warnings: [] });
    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/api/family-tree/import", expect.objectContaining({
      body: JSON.stringify({ gedcom: "0 HEAD", mode: "add" })
    })));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByText("Added 4 people")).toBeInTheDocument();
  });
});
