import { describe, expect, it } from "vitest";
import { applicationDiskUsage } from "../src/features/control/applicationStorage";
import { applicationState, type ApplicationsData } from "../src/features/control/applications";
import { ALL_SECTIONS_ON } from "../src/app/sections";
import type { Contents } from "../src/features/control/sections/StorageContentsSection";

const data: ApplicationsData = {
  sections: ALL_SECTIONS_ON, containers: [],
  libraries: { gallery: [], ebook: [], audiobook: [], video: [] }
};
const contents: Contents = {
  path: "/apps", staging: { path: null, bytes: 0, files: 0, complete: true },
  rooms: [{ room: "inbox", mode: "app", path: "/inbox", files: 1, bytes: 100, complete: true, library: null }],
  appFiles: { library: { id: "house", name: "App files", path: "/apps" }, folders: [
    { key: "recordings", folder: "Recordings", files: 1, bytes: 200, orphans: 0 },
    { key: "familyTree", folder: "Family", files: 1, bytes: 300, orphans: 0 },
    { key: "voiceNotes", folder: "Voice", files: 1, bytes: 400, orphans: 0 },
    { key: "music", folder: "Music", files: 1, bytes: 500, orphans: 0 },
    { key: "movies", folder: "Movies", files: 1, bytes: 600, orphans: 0 },
    { key: "other", folder: "", files: 1, bytes: 900, orphans: 0 }
  ] }
};

describe("application disk usage", () => {
  it("assigns app-file folders once, without charging Gallery for story or family files", () => {
    expect(applicationDiskUsage("gallery", applicationState("gallery", data), contents)).toMatchObject({ bytes: 1600, complete: true });
    expect(applicationDiskUsage("stories", applicationState("stories", data), contents)).toMatchObject({ bytes: 200, complete: true });
    expect(applicationDiskUsage("familyTree", applicationState("familyTree", data), contents)).toMatchObject({ bytes: 300, complete: true });
  });
  it("does not confuse unavailable measurements with zero usage", () => {
    expect(applicationDiskUsage("stories", applicationState("stories", data), null)).toMatchObject({ bytes: null, complete: false });
    expect(applicationDiskUsage("games", applicationState("games", data), contents)).toMatchObject({ bytes: null, complete: false });
    expect(applicationDiskUsage("ebooks", applicationState("ebooks", data), null)).toMatchObject({ bytes: 0, complete: true });
  });
  it("marks a partial sum rather than displaying it as the whole application's usage", () => {
    const state = applicationState("gallery", data);
    expect(applicationDiskUsage("gallery", { ...state, sizeBytes: 1000, sizeComplete: false }, contents)).toMatchObject({ bytes: 2600, complete: false });
    expect(applicationDiskUsage("gallery", { ...state, sizeBytes: 1000 }, null)).toMatchObject({ bytes: 1000, complete: false });
  });
  it("counts no App files library as empty when the request succeeded", () => {
    const empty = { ...contents, appFiles: { library: null, folders: [] } };
    expect(applicationDiskUsage("stories", applicationState("stories", data), empty)).toMatchObject({ bytes: 0, complete: true });
  });
});
