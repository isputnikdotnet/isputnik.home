import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsSection } from "../src/features/control/sections/DiagnosticsSection";
import { DiagnosticsPartPage } from "../src/features/control/diagnostics/PartPage";
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

// Saved reports, as the server keeps them (modules/diagnostics/saved.ts).
let saved: { id: string; createdAt: string; createdBy: string; createdByName: string; span: string; parts: string[]; hidden: string[]; sizeBytes: number; text: string }[] = [];
function savedApi(url: string, init?: RequestInit) {
  const id = url.split("/saved/")[1];
  if (init?.method === "POST") {
    const body = JSON.parse(String(init.body));
    saved.unshift({ id: `r${saved.length + 1}`, createdAt: "2026-11-14T10:00:00.000Z", createdBy: "admin", createdByName: "Ann", sizeBytes: body.text.length, ...body });
    return { report: saved[0] };
  }
  if (init?.method === "DELETE") {
    saved = saved.filter((report) => report.id !== id);
    return { ok: true };
  }
  if (id) return { report: saved.find((report) => report.id === id) };
  return { reports: saved.map(({ text: _text, ...summary }) => summary), kept: 10 };
}

beforeEach(() => {
  mockApi.mockReset();
  saved = [];
  mockApi.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/overview")) return { parts };
    if (url.endsWith("/logging")) return { level: "normal", until: null, minutes: [15, 60, 240] };
    if (url.includes("/api/admin/apps")) return { apps: [] };
    if (url.startsWith("/api/admin/diagnostics/saved")) return savedApi(url, init);
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

  it("opens the report with no private details in it, and adds one when ticked", async () => {
    const user = userEvent.setup();
    render(<DiagnosticsSection />);
    await user.click(await screen.findByRole("button", { name: /Download report/ }));
    const dialog = await screen.findByRole("dialog");
    // Three tabs: what goes in, privacy, and the report itself.
    await user.click(within(dialog).getByRole("tab", { name: "Report" }));
    expect(await within(dialog).findByText(/gallery: <name> at <path>/)).toBeTruthy();
    expect(mockApi).toHaveBeenCalledWith("/api/admin/diagnostics?hide=people,paths,names,net&since=day");

    await user.click(within(dialog).getByRole("tab", { name: "Privacy" }));
    await user.click(within(dialog).getByRole("switch", { name: /Include folders and file paths/ }));
    await user.click(within(dialog).getByRole("tab", { name: "Report" }));
    expect(await within(dialog).findByText(/gallery: Kids at \/mnt\/kids/)).toBeTruthy();
    expect(mockApi).toHaveBeenCalledWith("/api/admin/diagnostics?hide=people,names,net&since=day");

    // Leaving a part out takes it out of the text.
    await user.click(within(dialog).getByRole("tab", { name: "What goes in" }));
    await user.click(within(dialog).getByRole("switch", { name: /video container/ }));
    await user.click(within(dialog).getByRole("tab", { name: "Report" }));
    expect(within(dialog).queryByText(/gpu: vaapi/)).toBeNull();
  });
});

describe("logging", () => {
  it("turns on Detailed for an hour from the card's mode switch, and says until when", async () => {
    const user = userEvent.setup();
    render(<DiagnosticsSection />);
    const home = (await screen.findByRole("heading", { name: "iSputnik" })).closest("section") as HTMLElement;
    const modes = await within(home).findByRole("group", { name: "Diagnostic mode for iSputnik" });
    expect(await within(modes).findByRole("button", { name: "Normal" })).toHaveAttribute("aria-pressed", "true");
    mockApi.mockImplementationOnce(async () => ({ level: "detailed", until: "2026-11-14T15:40:00.000Z", minutes: [15, 60, 240] }));
    await user.click(within(modes).getByRole("button", { name: "Detailed" }));
    expect(mockApi).toHaveBeenCalledWith("/api/admin/logging", { method: "PUT", body: JSON.stringify({ level: "detailed", minutes: 60 }) });
    expect(await within(home).findByText(/^until /)).toBeTruthy();
    expect(within(modes).getByRole("button", { name: "Detailed" })).toHaveAttribute("aria-pressed", "true");

    // Raised, a timer shows how long — an hour — and changing it starts it again from now.
    const timer = within(home).getByRole("button", { name: /^For how long: 1 hour/ });
    mockApi.mockImplementationOnce(async () => ({ level: "detailed", until: "2026-11-14T18:40:00.000Z", minutes: [15, 60, 240] }));
    await user.click(timer);
    await user.click(within(home).getByRole("option", { name: /4 hours/ }));
    expect(mockApi).toHaveBeenCalledWith("/api/admin/logging", { method: "PUT", body: JSON.stringify({ level: "detailed", minutes: 240 }) });
    expect(await within(home).findByRole("button", { name: /^For how long: 4 hours/ })).toBeInTheDocument();
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

describe("saved reports", () => {
  // The main page saves but lists none (owner, 2026-11-19): a part's Reports tab does.
  it("saves the report as shown, lists it on a part's Reports tab, and opens and deletes it", async () => {
    const user = userEvent.setup();
    const main = render(<DiagnosticsSection />);

    await user.click(await screen.findByRole("button", { name: /Download report/ }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("switch", { name: /video container/ });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("button", { name: "Saved" })).toBeDisabled();
    const post = mockApi.mock.calls.find(([url, init]) => url === "/api/admin/diagnostics/saved" && init?.method === "POST");
    const body = JSON.parse(String(post?.[1]?.body));
    expect(body).toMatchObject({ span: "day", parts: ["system", "libraries", "container:video"], hidden: ["people", "paths", "names", "net"] });
    expect(body.text).toContain("gallery: <name> at <path>");
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByText("Saved reports")).toBeNull();
    main.unmount();

    render(<DiagnosticsPartPage part="home" tab="reports" />);
    const list = (await screen.findByText("Saved reports")).closest(".grouped-list-wrap, section, div") as HTMLElement;
    await user.click(await within(list).findByRole("button", { name: /private details hidden/ }));
    const viewer = await screen.findByRole("dialog");
    expect(await within(viewer).findByText(/gallery: <name> at <path>/)).toBeTruthy();
    expect(within(viewer).getByText(/saved by Ann/)).toBeTruthy();
    await user.click(within(viewer).getByRole("button", { name: "Delete" }));
    await user.click(await screen.findByRole("button", { name: "Delete report" }));
    expect(await screen.findByText(/None yet\. Save a report/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
