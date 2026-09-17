import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BulkTagChange } from "../src/shared/tags/BulkTagEditor";

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});

const { api } = await import("../src/api");
const { BulkTagEditor, NO_TAG_CHANGE } = await import("../src/shared/tags/BulkTagEditor");
const mockApi = vi.mocked(api);

// The editor for a selection: it opens on the tags the items already wear, and
// turns × and a pick into a pending { add, remove } for the dialog to send.

let last: BulkTagChange = NO_TAG_CHANGE;

function Harness() {
  const [change, setChange] = useState<BulkTagChange>(NO_TAG_CHANGE);
  return (
    <BulkTagEditor
      itemIds={["p1", "p2", "p3"]}
      suggestions={[{ name: "Crete 2019", uses: 40 }, { name: "Beach", uses: 12 }, { name: "Dacha", uses: 5 }]}
      value={change}
      onChange={(next) => { last = next; setChange(next); }}
    />
  );
}

async function setup() {
  render(<Harness />);
  await waitFor(() => expect(screen.getByText("Crete 2019")).toBeInTheDocument());
}

beforeEach(() => {
  last = NO_TAG_CHANGE;
  mockApi.mockReset();
  mockApi.mockResolvedValue({
    items: 3,
    tags: [{ name: "Crete 2019", count: 3 }, { name: "Beach", count: 1 }]
  } as never);
});

describe("BulkTagEditor", () => {
  it("lists the selection's tags, saying how many wear the ones not on all", async () => {
    await setup();
    expect(mockApi).toHaveBeenCalledWith("/api/library/items/tags/current", {
      method: "POST",
      body: JSON.stringify({ ids: ["p1", "p2", "p3"] })
    });
    expect(screen.getByText("on 1 of 3")).toBeInTheDocument();
    expect(screen.getAllByText(/^on \d+ of 3$/)).toHaveLength(1);
  });

  it("marks a tag to come off every item with ×, and undoes it", async () => {
    await setup();
    await userEvent.click(screen.getByRole("button", { name: "Take “Beach” off every selected item" }));
    expect(last).toEqual({ add: [], remove: ["Beach"] });
    await userEvent.click(screen.getByRole("button", { name: "Keep “Beach”" }));
    expect(last).toEqual({ add: [], remove: [] });
  });

  it("puts a picked tag on every item, a partly-worn one included", async () => {
    await setup();
    const box = screen.getByRole("combobox");
    await userEvent.type(box, "dach{Enter}");
    await userEvent.type(box, "beach{Enter}");
    expect(last).toEqual({ add: ["Dacha", "Beach"], remove: [] });
    expect(screen.getByText("2 tags to add")).toBeInTheDocument();
  });

  it("does not offer a tag every item already wears, until it is marked to come off", async () => {
    await setup();
    const box = screen.getByRole("combobox");
    await userEvent.type(box, "crete 2019");
    expect(screen.queryByRole("listbox")).toBeNull();
    await userEvent.clear(box);
    await userEvent.click(screen.getByRole("button", { name: "Take “Crete 2019” off every selected item" }));
    await userEvent.type(box, "crete 2019{Enter}");
    // Picking it again only undoes the removal.
    expect(last).toEqual({ add: [], remove: [] });
  });
});
