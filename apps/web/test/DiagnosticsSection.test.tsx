import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsSection } from "../src/features/control/sections/DiagnosticsSection";
import { reportText, type DiagnosticsReport } from "../src/features/control/diagnostics/ReportDialog";

vi.mock("../src/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/api")>()), api: vi.fn() }));
const { api } = await import("../src/api");
const mockApi = vi.mocked(api);

// Infrastructure › Diagnostics (docs/diagnostics-pages-plan.md): a card per part
// saying what needs a look, and one Download report button opening the dialog.
const parts = [
  { id: "home", state: "attention", version: "4.90.0", roundTripMs: null, libraries: 3, lastBackupAt: null,
    problems: [{ kind: "folderMissing", library: "Kids", libraryId: "lib-kids" }, { kind: "noBackup" }] },
  { id: "video", state: "ok", version: "0.39.0", roundTripMs: 6, problems: [] },
  { id: "games", state: "off", version: null, roundTripMs: null, problems: [] }
];

const report = (hidden: string[]): DiagnosticsReport => ({
  generatedAt: "2026-11-14T10:00:00.000Z",
  includesPrivate: hidden.length === 0,
  hidden: hidden as DiagnosticsReport["hidden"],
  sections: [
    { key: "system", title: "isputnik.home", lines: ["version: 4.90.0"] },
    { key: "libraries", title: "Libraries", lines: [hidden.includes("paths") ? "gallery: <name> at <path>" : "gallery: Kids at /mnt/kids"] },
    { key: "container:video", title: "video container", lines: ["gpu: vaapi"] }
  ]
});

beforeEach(() => {
  mockApi.mockReset();
  mockApi.mockImplementation(async (url: string) => {
    if (url.endsWith("/overview")) return { parts };
    if (url.includes("/api/admin/apps")) return { apps: [] };
    const hide = new URL(url, "http://x").searchParams.get("hide") ?? "";
    return { report: report(hide ? hide.split(",") : []) };
  });
});

describe("Diagnostics", () => {
  it("shows a card per part, with what needs a look and where to fix it", async () => {
    render(<DiagnosticsSection />);
    const home = (await screen.findByRole("heading", { name: "iSputnik" })).closest("section")!;
    expect(within(home as HTMLElement).getByText("Attention")).toBeTruthy();
    expect(within(home as HTMLElement).getByText(/Kids: folder isn't reachable · No backup yet/)).toBeTruthy();
    expect(within(home as HTMLElement).getByRole("link", { name: /Kids/ }).getAttribute("href")).toBe("/control/libraries/lib-kids");
    expect(screen.getByText("Answers in 6 ms")).toBeTruthy();
    expect(screen.getByText("Not set up")).toBeTruthy();
  });

  it("opens the report with everything hidden, and hides less when asked", async () => {
    const user = userEvent.setup();
    render(<DiagnosticsSection />);
    await user.click(await screen.findByRole("button", { name: /Download report/ }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/gallery: <name> at <path>/)).toBeTruthy();
    expect(mockApi).toHaveBeenCalledWith("/api/admin/diagnostics?hide=people,paths,names,net");

    await user.click(within(dialog).getByRole("switch", { name: /Folders and file paths/ }));
    expect(await within(dialog).findByText(/gallery: Kids at \/mnt\/kids/)).toBeTruthy();
    expect(mockApi).toHaveBeenCalledWith("/api/admin/diagnostics?hide=people,names,net");

    // Leaving a part out takes it out of the text.
    await user.click(within(dialog).getByRole("switch", { name: /video container/ }));
    expect(within(dialog).queryByText(/gpu: vaapi/)).toBeNull();
  });
});

describe("the report's text", () => {
  it("says what was hidden, and carries only the chosen parts", () => {
    const text = reportText(report(["people", "net"]), new Set(["system"]));
    expect(text).toContain("Hidden: <person>, <email>, <ip>, <host>.");
    expect(text).toContain("## isputnik.home");
    expect(text).not.toContain("## Libraries");
    expect(reportText(report([]), new Set(["system"]))).toContain("Names, folders and addresses are included.");
  });
});
