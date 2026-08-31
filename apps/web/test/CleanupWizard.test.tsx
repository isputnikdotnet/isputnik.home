import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn() }));
const { api } = await import("../src/api");
const { CleanupWizard } = await import("../src/features/control/sections/duplicates/CleanupWizard");
const mockApi = vi.mocked(api);

import type { DuplicateJob, LibraryOption } from "../src/features/control/sections/duplicates/cleanup-types";

// The wizard settles what a scan compares, and every answer is locked once it runs —
// so what matters here is that each question is asked, on the step it belongs to,
// and that a half-finished draft reopens where it was left.

const library = (id: string, over: Partial<LibraryOption> = {}): LibraryOption => ({
  id,
  name: id,
  sourcePath: `/srv/${id}`,
  mode: "managed",
  isProtected: false,
  candidateCount: 10,
  pendingCount: 0,
  ...over
});

const LIBRARIES = [
  library("Family"),
  library("Archive", { mode: "external", isProtected: true })
];

function mount(libraries = LIBRARIES, job: DuplicateJob | null = null) {
  return render(
    <CleanupWizard
      libraries={libraries}
      job={job}
      ownerName="Ada"
      onClose={() => {}}
      onSaved={async () => {}}
    />
  );
}

const rail = () => screen.getByRole("complementary", { name: "Duplicate cleanup steps" });
const railTitles = () =>
  [...rail().querySelectorAll(".cleanup-step-copy strong")].map((el) => el.textContent);
const subtitle = () => screen.getByText(/^Step \d of \d/).textContent;
const next = () => screen.getByRole("button", { name: /Next/ });

beforeEach(() => {
  mockApi.mockReset();
  mockApi.mockResolvedValue({ folders: [] } as never);
});

describe("cleanup wizard steps", () => {
  it("has four steps, with content type on its own", () => {
    mount();
    expect(railTitles()).toEqual(["Libraries", "Content type", "Folder instructions", "Summary"]);
    expect(subtitle()).toBe("Step 1 of 4 · Select libraries");
  });

  it("asks only about libraries first — the type questions come after", async () => {
    const user = userEvent.setup();
    mount();

    expect(screen.getByText("Family")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Cleanup type" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Media type" })).not.toBeInTheDocument();

    await user.click(next());
    expect(subtitle()).toBe("Step 2 of 4 · Content type");
    expect(screen.getByRole("group", { name: "Cleanup type" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Media type" })).toBeInTheDocument();
    // The library list is behind us now, not repeated.
    expect(screen.queryByRole("switch", { name: /Family/ })).not.toBeInTheDocument();
  });

  it("walks through to the summary, and only offers Run scan at the end", async () => {
    const user = userEvent.setup();
    mount();

    expect(screen.queryByRole("button", { name: /Run scan/ })).not.toBeInTheDocument();
    await user.click(next());
    await user.click(next());
    expect(subtitle()).toBe("Step 3 of 4 · Folder instructions");

    await user.click(next());
    expect(subtitle()).toBe("Step 4 of 4 · Summary");
    expect(screen.getByRole("button", { name: /Run scan/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Next/ })).not.toBeInTheDocument();
  });

  it("reads the folder list once the instructions step is reached, not before", async () => {
    const user = userEvent.setup();
    mount();
    expect(mockApi).not.toHaveBeenCalled();

    await user.click(next());
    expect(mockApi).not.toHaveBeenCalled();

    await user.click(next());
    expect(mockApi).toHaveBeenCalledWith(expect.stringContaining("folder-options"));
  });

  it("reopens a draft on the step it was left on", () => {
    mount(LIBRARIES, {
      id: "job-1", ownerUserId: "u1", ownerName: "Ada", status: "draft",
      duplicateType: "files", mediaType: "video", currentStep: 2, scanProgress: 0,
      statusDetail: null, createdAt: "", lastActivityAt: "", scanCompletedAt: null,
      libraries: [{
        libraryId: "Family", name: "Family", included: true, mode: "managed",
        isProtected: false, currentMode: "managed", currentlyProtected: false, missing: false
      }],
      folderPreferences: [],
      totals: {
        results: 0, reviewed: 0, skipped: 0, deleted: 0, remaining: 0,
        errors: 0, reclaimableBytes: 0, reclaimedBytes: 0
      }
    });

    expect(subtitle()).toBe("Step 2 of 4 · Content type");
    expect(screen.getByRole("group", { name: "Cleanup type" })).toBeInTheDocument();
  });
});

describe("folder instructions", () => {
  const FOLDERS = [
    { libraryId: "Family", libraryName: "Family", folderPath: "/odds-and-ends", photoCount: 4, isProtected: false, isLocked: false },
    { libraryId: "Family", libraryName: "Family", folderPath: "/holidays", photoCount: 4210, isProtected: false, isLocked: false },
    { libraryId: "Family", libraryName: "Family", folderPath: "/phone-dump", photoCount: 380, isProtected: false, isLocked: false }
  ];

  const openInstructions = async (user: ReturnType<typeof userEvent.setup>) => {
    mockApi.mockResolvedValue({ folders: FOLDERS } as never);
    mount();
    await user.click(next());
    await user.click(next());
  };

  it("puts the biggest folders first, where an instruction is worth giving", async () => {
    const user = userEvent.setup();
    await openInstructions(user);

    const names = [...document.querySelectorAll(".dup-folder-choice-body strong")].map((el) => el.textContent);
    expect(names).toEqual(["/holidays", "/phone-dump", "/odds-and-ends"]);
  });

  it("keeps that order while a search narrows the list", async () => {
    const user = userEvent.setup();
    await openInstructions(user);
    await user.type(screen.getByLabelText("Find a folder in this list"), "o");

    const names = [...document.querySelectorAll(".dup-folder-choice-body strong")].map((el) => el.textContent);
    expect(names).toEqual(["/holidays", "/phone-dump", "/odds-and-ends"]);
  });

  it("keeps the explanation behind the info button until it is asked for", async () => {
    const user = userEvent.setup();
    await openInstructions(user);

    expect(screen.queryByText(/Nothing is inherited/)).not.toBeInTheDocument();

    const hint = screen.getByRole("button", { name: "About folder instructions" });
    expect(hint).toHaveAttribute("aria-expanded", "false");

    await user.click(hint);
    expect(screen.getByText(/Nothing is inherited/)).toBeInTheDocument();
    expect(hint).toHaveAttribute("aria-expanded", "true");

    // Clicking it a second time puts it away again.
    await user.click(hint);
    expect(screen.queryByText(/Nothing is inherited/)).not.toBeInTheDocument();
  });

  it("shows the explanation on hover too, and takes it back when the pointer leaves", async () => {
    const user = userEvent.setup();
    await openInstructions(user);

    await user.hover(screen.getByRole("button", { name: "About folder instructions" }));
    expect(screen.getByText(/Nothing is inherited/)).toBeInTheDocument();

    await user.unhover(screen.getByRole("button", { name: "About folder instructions" }));
    expect(screen.queryByText(/Nothing is inherited/)).not.toBeInTheDocument();
  });

  it("refuses Clear on a locked folder, with the lock as the reason", async () => {
    const user = userEvent.setup();
    mockApi.mockResolvedValue({
      folders: [
        ...FOLDERS,
        { libraryId: "Family", libraryName: "Family", folderPath: "/vault", photoCount: 12, isProtected: false, isLocked: true }
      ]
    } as never);
    mount();
    await user.click(next());
    await user.click(next());

    const row = [...document.querySelectorAll(".dup-folder-choice")].find((el) =>
      el.querySelector(".dup-folder-choice-body strong")?.textContent === "/vault"
    ) as HTMLElement;
    const clear = [...row.querySelectorAll("label.dup-mode")].find((el) => el.textContent?.includes("Clear")) as HTMLElement;
    expect(clear.className).toContain("is-blocked");
    expect(clear.getAttribute("title")).toMatch(/locked/i);
    expect(clear.querySelector("input")).toBeDisabled();

    // An unlocked sibling's Clear stays live.
    const free = [...document.querySelectorAll(".dup-folder-choice")].find((el) =>
      el.querySelector(".dup-folder-choice-body strong")?.textContent === "/holidays"
    ) as HTMLElement;
    const freeClear = [...free.querySelectorAll("label.dup-mode")].find((el) => el.textContent?.includes("Clear")) as HTMLElement;
    expect(freeClear.querySelector("input")).not.toBeDisabled();
  });

  it("does not snatch a pinned explanation away when the pointer leaves", async () => {
    const user = userEvent.setup();
    await openInstructions(user);

    const hint = screen.getByRole("button", { name: "About folder instructions" });
    await user.click(hint);
    await user.unhover(hint);
    expect(screen.getByText(/Nothing is inherited/)).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByText(/Nothing is inherited/)).not.toBeInTheDocument();
  });
});

describe("library rows", () => {
  it("gives every library a padlock cell, open or shut", () => {
    mount();
    const rows = [...document.querySelectorAll(".cleanup-library-row")];
    expect(rows).toHaveLength(2);

    // The cell is what keeps the toggles in line, so it has to exist on every row.
    for (const row of rows) {
      expect(row.querySelector(".cleanup-library-lock")).not.toBeNull();
    }
    // …and only the read-only one is marked as locked.
    const locked = rows.filter((row) => row.querySelector(".cleanup-library-lock.is-locked"));
    expect(locked).toHaveLength(1);
    expect(within(locked[0] as HTMLElement).getByText("Archive")).toBeInTheDocument();
  });

  it("says which way round the padlock is, in words", () => {
    mount();
    const [managed, external] = [...document.querySelectorAll(".cleanup-library-lock")];
    expect(managed.getAttribute("title")).toMatch(/can be cleaned up/);
    expect(external.getAttribute("title")).toMatch(/never removed/);
  });

  it("puts the same children in the same order on every row", () => {
    mount();
    const shapes = [...document.querySelectorAll(".cleanup-library-row")].map((row) =>
      [...row.children].map((child) => child.className.split(" ")[0])
    );
    expect(shapes[0]).toEqual(shapes[1]);
  });
});
