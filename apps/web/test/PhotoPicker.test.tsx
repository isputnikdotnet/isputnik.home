import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn(), csrfToken: vi.fn(() => "csrf-token") }));

const { api } = await import("../src/api");
const { PhotoPicker } = await import("../src/features/gallery/PhotoPicker");
const mockApi = vi.mocked(api);

// Opening a folder from the search results is a two-step dance across a 300ms
// debounce: the click loads the folder, and clearing the search box lands in
// the folder effect a beat later as "the query went empty". That second half
// used to reset the picker to All folders on top of the folder just opened —
// the search vanished and so did the folder (reported from "Add photos to this
// event"). These hold the two halves apart.

interface Folder {
  path: string;
  name: string;
  assetCount: number;
  coverUrl: string | null;
}

const folder = (path: string, name: string): Folder => ({ path, name, assetCount: 3, coverUrl: null });

const ROOT = [folder("2019", "2019"), folder("2020", "2020")];
const MATCHES = [folder("2019/Summer at the lake", "Summer at the lake")];
const INSIDE = [folder("2019/Summer at the lake/Day one", "Day one")];

/** Answer the picker's endpoints, and record every folder-browse parent asked for. */
function stubGallery() {
  const browsed: string[] = [];
  mockApi.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/library/gallery-libraries")) return { libraries: [] };
    if (path.startsWith("/api/library/gallery/folders/search")) return { folders: MATCHES };
    if (path.startsWith("/api/library/gallery/folders")) {
      const parent = decodeURIComponent(new URLSearchParams(path.split("?")[1]).get("parent") ?? "");
      browsed.push(parent);
      return { parent, folders: parent === "" ? ROOT : INSIDE, assets: [] };
    }
    return {};
  });
  return browsed;
}

function renderPicker() {
  return render(
    <PhotoPicker
      title="Add photos to this event"
      onAttach={async () => {}}
      onClose={() => {}}
    />
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockApi.mockReset();
});

describe("PhotoPicker folder search", () => {
  it("opens the folder you clicked instead of falling back to All folders", async () => {
    const browsed = stubGallery();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPicker();
    await screen.findByRole("button", { name: /2019/ });

    await user.type(screen.getByPlaceholderText("Search folders"), "Summer");
    const match = await screen.findByRole("button", { name: /Summer at the lake/ });
    await user.click(match);

    // The debounce that follows the cleared search box must not undo the click.
    await vi.advanceTimersByTimeAsync(600);

    await waitFor(() => expect(screen.getByRole("button", { name: /Day one/ })).toBeTruthy());
    expect(browsed.at(-1)).toBe("2019/Summer at the lake");
    expect(screen.queryByText("Matching folders")).toBeNull();
  });

  it("still returns to All folders when the search is cleared by hand", async () => {
    const browsed = stubGallery();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPicker();
    await screen.findByRole("button", { name: /2019/ });

    const box = screen.getByPlaceholderText("Search folders");
    await user.type(box, "Summer");
    await screen.findByText("Matching folders");

    await user.clear(box);
    await vi.advanceTimersByTimeAsync(600);

    await waitFor(() => expect(browsed.at(-1)).toBe(""));
    expect(screen.queryByText("Matching folders")).toBeNull();
  });
});
