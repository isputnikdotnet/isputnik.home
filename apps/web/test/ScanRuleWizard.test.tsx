import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});

const { api } = await import("../src/api");
const { ScanRuleWizard } = await import("../src/features/control/layout/ScanRuleWizard");

const library = { id: "lib", name: "Books", type: "ebook" as const };

beforeEach(() => {
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path.startsWith("/api/library/libraries/lib/folders")) {
      return {
        path: "", parent: null, books: 0, ownedBy: null, totalBooks: 12,
        folders: [{ name: "Fiction", relativePath: "Fiction", books: 12, ownedBy: null }]
      } as never;
    }
    if (path.includes("/scan-rules/examples")) return { examples: [{ anchor: "Fiction", path: "Stevenson/Treasure Island.epub" }] } as never;
    if (path.includes("/scan-rules/preview")) return { rows: [] } as never;
    return {} as never;
  });
});

// A new rule is named after its first folder and its first layout, until somebody
// types a name. That name is COMPUTED from those two, not pushed into state from an
// effect: as state it lagged a render behind the step just changed, so the Next
// button (which gates on the name being non-empty) and a save fired in that window
// read the name built from the PREVIOUS folder.
describe("ScanRuleWizard rule name", () => {
  const ruleName = () => screen.getByLabelText("Rule name") as HTMLInputElement;

  async function reachLayoutStep(user: ReturnType<typeof userEvent.setup>) {
    render(
      <ScanRuleWizard
        library={library}
        target={{ kind: "rule", rule: null }}
        existingRules={[]}
        onClose={() => {}}
        onSaved={() => {}}
        onSavedAndScanned={() => {}}
      />
    );
    await user.click(await screen.findByRole("checkbox", { name: /Fiction/ }));
    await user.click(screen.getByRole("button", { name: /Next: Layout/ }));
  }

  // The presets are named by their pattern as well as their words, so each is
  // asked for by both — "Series / 01 - Title" is otherwise a substring of
  // "Author / Series / 01 - Title".
  const preset = (label: string, pattern: string) => screen.getByRole("button", { name: `${label}${pattern}` });

  it("names itself from the folder and the layout it is on", async () => {
    const user = userEvent.setup();
    await reachLayoutStep(user);
    // The folder chosen, plus the layout guessed from the first example.
    expect(ruleName()).toHaveValue("Fiction · Author / Title");

    // Another preset, and the name has followed it in the same render. (The example
    // is two folders deep, so the preset lands on its first two roles.)
    await user.click(preset("Series / 01 - Title", "{series}/{position} - {title}"));
    expect(ruleName()).toHaveValue("Fiction · Series / 01");
  });

  it("hands the name over the moment it is typed, and stops following the layout", async () => {
    const user = userEvent.setup();
    await reachLayoutStep(user);

    await user.clear(ruleName());
    await user.type(ruleName(), "The fiction shelf");
    expect(ruleName()).toHaveValue("The fiction shelf");

    // Another layout picked: the auto name would change, the typed one must not.
    await user.click(preset("Series / 01 - Title", "{series}/{position} - {title}"));
    expect(ruleName()).toHaveValue("The fiction shelf");
  });
});
