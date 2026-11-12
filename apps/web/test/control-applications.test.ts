import { describe, expect, it } from "vitest";
import { ALL_SECTIONS_ON } from "../src/app/sections";
import { APP_LOG_PREFIXES, APP_TASK_SCOPE, applicationParam, applicationState, type ApplicationsData, type AppLibrary } from "../src/features/control/applications";
import type { AppStatus } from "../src/features/control/sections/AppsSection";

// What the Applications directory and each Setup tab say about an application:
// turned off wins, then the first thing it is missing (its container, then a
// library), else ready (docs/control-panel-v2-plan.md, phase 2).

const library = (id: string, sizeBytes: number | null = 1000): AppLibrary => ({
  id, name: id, items: 1, sizeBytes, scanStatus: "idle", lastScannedAt: null, personal: false
});

const container = (id: string, ok: boolean): AppStatus => ({
  id,
  kind: "app",
  stateless: false,
  prefix: `/${id}`,
  configured: true,
  reason: null,
  url: "http://x",
  urlSource: "saved",
  exampleUrl: "",
  secretSet: true,
  secretSource: "paired",
  pairing: null,
  variables: { url: "", secret: "", container: "" },
  secretAccepted: true,
  server: { ok, version: "1.0.0", error: null, roundTripMs: 5 }
});

function data(over: Partial<ApplicationsData> = {}): ApplicationsData {
  return {
    sections: { ...ALL_SECTIONS_ON },
    containers: [],
    libraries: { gallery: [], video: [], ebook: [], audiobook: [] },
    ...over
  };
}

describe("applicationState", () => {
  it("says turned off before anything it is missing", () => {
    const state = applicationState("videos", data({ sections: { ...ALL_SECTIONS_ON, video: false } }));
    expect(state).toMatchObject({ status: "off", gap: null });
  });

  it("needs its container first, then a library", () => {
    expect(applicationState("videos", data())).toMatchObject({ status: "needsSetup", gap: "connection" });
    expect(applicationState("videos", data({ containers: [container("video", true)] }))).toMatchObject({ status: "needsSetup", gap: "libraries" });
    expect(applicationState("videos", data({
      containers: [container("video", true)],
      libraries: { gallery: [], video: [library("v1")], ebook: [], audiobook: [] }
    }))).toMatchObject({ status: "ready", gap: null });
  });

  it("does not hold Gallery back for the face engine, which it can do without", () => {
    const state = applicationState("gallery", data({ libraries: { gallery: [library("g1")], video: [], ebook: [], audiobook: [] } }));
    expect(state.status).toBe("ready");
  });

  it("adds up the sizes it knows, and says so when it knows none", () => {
    const sized = applicationState("ebooks", data({ libraries: { gallery: [], video: [], ebook: [library("a", 300), library("b", 700), library("c", null)], audiobook: [] } }));
    expect(sized.sizeBytes).toBe(1000);
    const unsized = applicationState("ebooks", data({ libraries: { gallery: [], video: [], ebook: [library("c", null)], audiobook: [] } }));
    expect(unsized.sizeBytes).toBeNull();
  });

  it("is ready when on, for an application with no libraries or container", () => {
    expect(applicationState("familyTree", data()).status).toBe("ready");
    expect(applicationState("shared", data()).status).toBeNull();
  });
});

describe("application filters", () => {
  it("reads ?application= only as an application the page can filter by", () => {
    expect(applicationParam("gallery", APP_TASK_SCOPE)).toBe("gallery");
    // Games has a log but no tasks of its own.
    expect(applicationParam("games", APP_TASK_SCOPE)).toBe("");
    expect(applicationParam("games", APP_LOG_PREFIXES)).toBe("games");
    expect(applicationParam("toString", APP_LOG_PREFIXES)).toBe("");
    expect(applicationParam(null, APP_LOG_PREFIXES)).toBe("");
  });

  // The server takes only [a-z_.] prefixes (core/logs.ts) and [A-Za-z_-] job types.
  it("sends the server only prefixes and job types it will accept", () => {
    for (const prefixes of Object.values(APP_LOG_PREFIXES)) for (const prefix of prefixes ?? []) expect(prefix).toMatch(/^[a-z_.]{1,60}$/);
    for (const scope of Object.values(APP_TASK_SCOPE)) for (const type of scope?.types ?? []) expect(type).toMatch(/^[A-Za-z_-]{1,60}$/);
  });
});
