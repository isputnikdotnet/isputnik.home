// Duplicate cleanup JOBS — the entity, not the cleanup. Covers the one-active-job
// lock, ownership (work vs retire), the draft-only scope lock, preferences seeded
// from the global set and then diverging, and the derived inheritance that replaced
// the stored inherited_from/locked columns.
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import {
  activeJob,
  cancelJob,
  completeJob,
  createJob,
  deleteJob,
  galleryLibraryOptions,
  getJob,
  jobPreferenceFor,
  reassignJob,
  recentJobs,
  setJobFolderPreferences,
  setJobStatus,
  updateJobScope
} from "../src/modules/library/gallery/duplicate-jobs.js";
import { setFolderPreferences } from "../src/modules/library/gallery/duplicates.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

const EXTERNAL = JSON.stringify({ mode: "external" });
const NO_DELETE = JSON.stringify({ mode: "managed", allowDelete: false });

beforeEach(() => {
  resetDb();
  makeUser("u1", "admin");
  makeUser("u2", "admin");
  makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
  makeLibrary("GAL2", { createdBy: "u1", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
  grant("group", EVERYONE_GROUP_ID, "GAL2", "member");
});

const start = (libraries = ["GAL", "GAL2"], owner = "u1") =>
  createJob({ ownerUserId: owner, libraryIds: libraries });

describe("the wizard's library list", () => {
  it("offers photo libraries only, and says which may not be deleted from", () => {
    makeLibrary("BOOKS", { createdBy: "u1", type: "audiobook" });
    makeLibrary("EXT", { createdBy: "u1", type: "gallery", policyJson: EXTERNAL });
    makeLibrary("LOCKED", { createdBy: "u1", type: "gallery", policyJson: NO_DELETE });

    const options = galleryLibraryOptions();
    expect(options.map((library) => library.id).sort()).toEqual(["EXT", "GAL", "GAL2", "LOCKED"]);
    expect(options.find((library) => library.id === "EXT")).toMatchObject({ mode: "external", isProtected: true });
    // Not external, but nothing may be removed from it either — the deletion side
    // treats the two the same and the wizard has to say so.
    expect(options.find((library) => library.id === "LOCKED")).toMatchObject({ mode: "managed", isProtected: true });
    expect(options.find((library) => library.id === "GAL")).toMatchObject({ mode: "managed", isProtected: false });
  });
});

describe("one active job", () => {
  it("refuses a second job while one is active", () => {
    expect(start().ok).toBe(true);
    const second = start(["GAL"], "u2");
    expect(second).toMatchObject({ ok: false, refused: "already_active" });
  });

  it("is enforced by the database, not only by the check above", () => {
    const first = start();
    expect(first.ok).toBe(true);
    // Straight past createJob, the way a second browser tab racing the check would.
    expect(() => db.prepare(
      "INSERT INTO duplicate_jobs (id, owner_user_id, status) VALUES ('sneak', 'u2', 'review')"
    ).run()).toThrow(/UNIQUE/);
  });

  it("lets a new job start once the last one is finished", () => {
    const first = start();
    if (!first.ok) throw new Error("expected a job");
    expect(completeJob(first.job.id, "u1", true).ok).toBe(true);

    const second = start(["GAL"], "u2");
    expect(second.ok).toBe(true);
    expect(activeJob()?.ownerUserId).toBe("u2");
    expect(recentJobs().map((job) => job.id)).toEqual([first.job.id]);
  });

  it("counts cancelled and deleted jobs as finished too", () => {
    const first = start();
    if (!first.ok) throw new Error("expected a job");
    expect(cancelJob(first.job.id, "u1", true, "changed my mind").ok).toBe(true);
    expect(activeJob()).toBeNull();

    const second = start(["GAL"]);
    if (!second.ok) throw new Error("expected a second job");
    expect(deleteJob(second.job.id, "u1", true).ok).toBe(true);
    expect(activeJob()).toBeNull();
    expect(start(["GAL"]).ok).toBe(true);
  });

  it("needs at least one library", () => {
    expect(createJob({ ownerUserId: "u1", libraryIds: [] })).toMatchObject({ ok: false, refused: "no_libraries" });
    // A library that isn't a photo library is not one of the choices, so a request
    // naming only those is the same as naming none.
    makeLibrary("BOOKS", { createdBy: "u1", type: "audiobook" });
    expect(createJob({ ownerUserId: "u1", libraryIds: ["BOOKS"] })).toMatchObject({ ok: false, refused: "no_libraries" });
  });
});

describe("ownership", () => {
  it("lets only the owner change the job", () => {
    const created = start(["GAL"], "u1");
    if (!created.ok) throw new Error("expected a job");
    expect(updateJobScope(created.job.id, "u2", { mediaType: "photo" }))
      .toMatchObject({ ok: false, refused: "not_owner" });
    expect(setJobFolderPreferences(created.job.id, "u2", []))
      .toMatchObject({ ok: false, refused: "not_owner" });
    expect(updateJobScope(created.job.id, "u1", { mediaType: "photo" }).ok).toBe(true);
  });

  // The lock exists so two admins don't work the same cleanup at once — not so the
  // install is stranded when the one who started it doesn't come back.
  it("lets another admin retire or take over a job they don't own", () => {
    const created = start(["GAL"], "u1");
    if (!created.ok) throw new Error("expected a job");

    expect(reassignJob(created.job.id, "u2", "u2").ok).toBe(true);
    expect(getJob(created.job.id)?.ownerUserId).toBe("u2");
    // And now the new owner may work it, which the old one no longer can.
    expect(updateJobScope(created.job.id, "u1", { mediaType: "photo" }))
      .toMatchObject({ ok: false, refused: "not_owner" });
    expect(updateJobScope(created.job.id, "u2", { mediaType: "photo" }).ok).toBe(true);
    expect(cancelJob(created.job.id, "u1", true).ok).toBe(true);
  });

  it("refuses to hand a job to someone who isn't there", () => {
    const created = start(["GAL"]);
    if (!created.ok) throw new Error("expected a job");
    expect(reassignJob(created.job.id, "ghost", "u1")).toMatchObject({ ok: false, refused: "not_found" });
  });

  it("refuses to finish a job that is already finished", () => {
    const created = start(["GAL"]);
    if (!created.ok) throw new Error("expected a job");
    expect(completeJob(created.job.id, "u1", true).ok).toBe(true);
    expect(completeJob(created.job.id, "u1", true)).toMatchObject({ ok: false, refused: "not_reviewable" });
    expect(cancelJob(created.job.id, "u1", true)).toMatchObject({ ok: false, refused: "not_reviewable" });
  });
});

describe("scope, locked once the scan has run", () => {
  it("takes library and scan-type changes while it is a draft", () => {
    const created = start(["GAL", "GAL2"]);
    if (!created.ok) throw new Error("expected a job");

    const updated = updateJobScope(created.job.id, "u1", {
      libraryIds: ["GAL"], duplicateType: "folders", mediaType: "photo", currentStep: 2
    });
    if (!updated.ok) throw new Error("expected the update to land");
    expect(updated.job.libraries.map((library) => library.libraryId)).toEqual(["GAL"]);
    expect(updated.job).toMatchObject({ duplicateType: "folders", mediaType: "photo", currentStep: 2 });
  });

  it("refuses them once scanning has started", () => {
    const created = start(["GAL"]);
    if (!created.ok) throw new Error("expected a job");
    setJobStatus(created.job.id, "u1", "scanning");
    expect(updateJobScope(created.job.id, "u1", { mediaType: "photo" }))
      .toMatchObject({ ok: false, refused: "locked" });
    // Preferences are NOT scope — they are reviewed after the scan, by design.
    expect(setJobFolderPreferences(created.job.id, "u1", []).ok).toBe(true);
  });

  it("records what each library was when the job was created", () => {
    makeLibrary("EXT", { createdBy: "u1", type: "gallery", policyJson: EXTERNAL });
    const created = start(["GAL", "EXT"]);
    if (!created.ok) throw new Error("expected a job");
    expect(created.job.libraries.find((library) => library.libraryId === "EXT"))
      .toMatchObject({ mode: "external", isProtected: true });

    // The library turns internal after the job was scoped. The snapshot must keep
    // saying what the job was reviewed under, and flag that the two now differ.
    db.prepare("UPDATE libraries SET policy_json = '{}' WHERE id = 'EXT'").run();
    const later = getJob(created.job.id)!;
    const ext = later.libraries.find((library) => library.libraryId === "EXT")!;
    expect(ext.isProtected).toBe(true);
    expect(ext.currentlyProtected).toBe(false);
    expect(ext.mode).toBe("external");
    expect(ext.currentMode).toBe("managed");
  });
});

describe("folder preferences", () => {
  it("seeds from the global instructions, then goes its own way", () => {
    setFolderPreferences([
      { libraryId: "GAL", folderPath: "Photos", mode: "keep" },
      { libraryId: "GAL2", folderPath: "Dump", mode: "clear" }
    ]);

    const created = start(["GAL", "GAL2"]);
    if (!created.ok) throw new Error("expected a job");
    expect(created.job.folderPreferences).toEqual([
      { libraryId: "GAL", folderPath: "Photos", mode: "keep" },
      { libraryId: "GAL2", folderPath: "Dump", mode: "clear" }
    ]);

    setJobFolderPreferences(created.job.id, "u1", [
      { libraryId: "GAL", folderPath: "Photos", mode: "clear" }
    ]);

    // The job changed; the global set the older pages read did not.
    expect(getJob(created.job.id)?.folderPreferences).toEqual([
      { libraryId: "GAL", folderPath: "Photos", mode: "clear" }
    ]);
    const global = db.prepare("SELECT value FROM app_settings WHERE key LIKE '%folder%'").get() as
      | { value: string }
      | undefined;
    expect(JSON.parse(global!.value)).toEqual([
      { libraryId: "GAL", folderPath: "Photos", mode: "keep" },
      { libraryId: "GAL2", folderPath: "Dump", mode: "clear" }
    ]);
  });

  it("only seeds preferences for libraries the job covers", () => {
    setFolderPreferences([
      { libraryId: "GAL", folderPath: "Photos", mode: "keep" },
      { libraryId: "GAL2", folderPath: "Dump", mode: "clear" }
    ]);
    const created = start(["GAL"]);
    if (!created.ok) throw new Error("expected a job");
    expect(created.job.folderPreferences).toEqual([
      { libraryId: "GAL", folderPath: "Photos", mode: "keep" }
    ]);
  });

  it("drops a preference whose library leaves the job", () => {
    setFolderPreferences([{ libraryId: "GAL2", folderPath: "Dump", mode: "clear" }]);
    const created = start(["GAL", "GAL2"]);
    if (!created.ok) throw new Error("expected a job");
    expect(created.job.folderPreferences).toHaveLength(1);

    const updated = updateJobScope(created.job.id, "u1", { libraryIds: ["GAL"] });
    if (!updated.ok) throw new Error("expected the update to land");
    expect(updated.job.folderPreferences).toEqual([]);
  });

  // "Clear out" means "let this folder's copies go", which an external library can't
  // do — its files are not ours to remove. Stored, it would be an instruction the
  // scan has to ignore later, which is how a keeper choice starts disagreeing with
  // the page that set it.
  it("refuses to store a Clear on a library nothing may be deleted from", () => {
    makeLibrary("EXT", { createdBy: "u1", type: "gallery", policyJson: EXTERNAL });
    const created = start(["GAL", "EXT"]);
    if (!created.ok) throw new Error("expected a job");

    const saved = setJobFolderPreferences(created.job.id, "u1", [
      { libraryId: "EXT", folderPath: "Sync", mode: "clear" },
      { libraryId: "EXT", folderPath: "Keepers", mode: "keep" },
      { libraryId: "GAL", folderPath: "Dump", mode: "clear" }
    ]);
    if (!saved.ok) throw new Error("expected the save to land");
    expect(saved.job.folderPreferences).toEqual([
      { libraryId: "EXT", folderPath: "Keepers", mode: "keep" },
      { libraryId: "GAL", folderPath: "Dump", mode: "clear" }
    ]);
  });

  it("ignores a preference for a library the job never included", () => {
    const created = start(["GAL"]);
    if (!created.ok) throw new Error("expected a job");
    const saved = setJobFolderPreferences(created.job.id, "u1", [
      { libraryId: "GAL2", folderPath: "Anywhere", mode: "keep" }
    ]);
    if (!saved.ok) throw new Error("expected the save to land");
    expect(saved.job.folderPreferences).toEqual([]);
  });
});

// Inheritance is derived, which is why the proposal's inherited_from and locked
// columns aren't in the schema: the answer is a function of the list plus the path,
// and a stored copy can only drift from it.
describe("which instruction applies to a path", () => {
  const preferences = [
    { libraryId: "GAL", folderPath: "", mode: "keep" as const },
    { libraryId: "GAL", folderPath: "Photos/Unsorted", mode: "clear" as const },
    { libraryId: "GAL2", folderPath: "Other", mode: "keep" as const }
  ];

  it("lets the most specific folder win", () => {
    expect(jobPreferenceFor(preferences, "GAL", "Photos/Unsorted/2019")).toBe("clear");
    expect(jobPreferenceFor(preferences, "GAL", "Photos/2019")).toBe("keep");
  });

  it("covers everything below a folder, and nothing outside its library", () => {
    expect(jobPreferenceFor(preferences, "GAL", "anything/at/all")).toBe("keep");
    expect(jobPreferenceFor(preferences, "GAL2", "elsewhere")).toBeNull();
    // A prefix that isn't a folder boundary is not a match: "Otherwise" is not
    // inside "Other".
    expect(jobPreferenceFor(preferences, "GAL2", "Otherwise/x")).toBeNull();
    expect(jobPreferenceFor(preferences, "GAL2", "Other/x")).toBe("keep");
  });
});

describe("totals", () => {
  it("start empty and survive a job with no scan yet", () => {
    const created = start(["GAL"]);
    if (!created.ok) throw new Error("expected a job");
    expect(created.job.totals).toEqual({
      results: 0, reviewed: 0, skipped: 0, deleted: 0,
      remaining: 0, errors: 0, reclaimableBytes: 0, reclaimedBytes: 0
    });
  });
});
