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
  jobFolderOptions,
  jobPreferenceFor,
  reassignJob,
  recentJobs,
  setJobFolderPreferences,
  setJobStatus,
  updateJobScope
} from "../src/modules/library/gallery/duplicates/jobs.js";
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

// A catalogued photo at a path. Enough for the folder list, which reads the catalogue
// and never touches a fingerprint.
function photo(id: string, library: string, relativePath: string, deleted = false): string {
  db.prepare(`
    INSERT INTO library_items (id, library_id, type, folder_path, status, deleted_at)
    VALUES (?, ?, 'gallery', ?, 'ready', ?)
  `).run(id, library, relativePath, deleted ? new Date().toISOString() : null);
  db.prepare(`
    INSERT INTO gallery_details (item_id, kind, relative_path, size, modified_at)
    VALUES (?, 'photo', ?, 1000, 'm1')
  `).run(id, relativePath);
  return id;
}

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
  // A cleanup's instructions are its own and start empty. There WAS an install-wide
  // set that seeded every new job; its only editor was on the pages that have since
  // been retired, and a standing rule nobody can edit is worse than no standing rule.
  it("start empty on a new cleanup", () => {
    const created = start(["GAL", "GAL2"]);
    if (!created.ok) throw new Error("expected a job");
    expect(created.job.folderPreferences).toEqual([]);
  });

  it("are kept per job, so one cleanup's instructions never reach another", () => {
    const first = start(["GAL", "GAL2"]);
    if (!first.ok) throw new Error("expected a job");
    setJobFolderPreferences(first.job.id, "u1", [
      { libraryId: "GAL", folderPath: "Photos", mode: "keep" }
    ]);
    expect(getJob(first.job.id)?.folderPreferences).toEqual([
      { libraryId: "GAL", folderPath: "Photos", mode: "keep" }
    ]);

    completeJob(first.job.id, "u1", true);
    const second = start(["GAL", "GAL2"]);
    if (!second.ok) throw new Error("expected a second job");
    expect(second.job.folderPreferences).toEqual([]);
  });

  it("ignores an instruction for a library the job does not cover", () => {
    const created = start(["GAL"]);
    if (!created.ok) throw new Error("expected a job");
    setJobFolderPreferences(created.job.id, "u1", [
      { libraryId: "GAL", folderPath: "Photos", mode: "keep" },
      { libraryId: "GAL2", folderPath: "Dump", mode: "clear" }
    ]);
    expect(getJob(created.job.id)?.folderPreferences).toEqual([
      { libraryId: "GAL", folderPath: "Photos", mode: "keep" }
    ]);
  });

  it("drops a preference whose library leaves the job", () => {
    const created = start(["GAL", "GAL2"]);
    if (!created.ok) throw new Error("expected a job");
    setJobFolderPreferences(created.job.id, "u1", [
      { libraryId: "GAL2", folderPath: "Dump", mode: "clear" }
    ]);
    expect(getJob(created.job.id)?.folderPreferences).toHaveLength(1);

    const updated = updateJobScope(created.job.id, "u1", { libraryIds: ["GAL"] });
    if (!updated.ok) throw new Error("expected the update to land");
    expect(getJob(created.job.id)?.folderPreferences).toEqual([]);
  });
});

describe("the folders an instruction can be attached to", () => {
  it("lists every folder holding photos, with its count", () => {
    photo("p1", "GAL", "2024/Trip/one.jpg");
    photo("p2", "GAL", "2024/Trip/two.jpg");
    photo("p3", "GAL", "2024/other.jpg");

    expect(jobFolderOptions(["GAL"])).toEqual([
      { libraryId: "GAL", libraryName: "GAL", folderPath: "2024", photoCount: 1, isProtected: false, isLocked: false },
      { libraryId: "GAL", libraryName: "GAL", folderPath: "2024/Trip", photoCount: 2, isProtected: false, isLocked: false }
    ]);
  });

  // Before the scan there are no duplicates to list folders BY — which is the whole
  // reason this reads the catalogue rather than a scan's results.
  it("lists them without a scan having run", () => {
    photo("p1", "GAL", "one.jpg");
    expect(db.prepare("SELECT COUNT(*) AS n FROM duplicate_job_results").get()).toEqual({ n: 0 });
    // A photo at the library root belongs to the library itself, which is the row an
    // instruction about the whole library is attached to.
    expect(jobFolderOptions(["GAL"])).toEqual([
      { libraryId: "GAL", libraryName: "GAL", folderPath: "", photoCount: 1, isProtected: false, isLocked: false }
    ]);
  });

  it("covers only the libraries asked for, and skips deleted photos", () => {
    photo("p1", "GAL", "Kept/one.jpg");
    photo("p2", "GAL2", "Elsewhere/two.jpg");
    photo("p3", "GAL", "Gone/three.jpg", true);

    expect(jobFolderOptions(["GAL"]).map((option) => option.folderPath)).toEqual(["Kept"]);
    expect(jobFolderOptions(["GAL", "GAL2"]).map((option) => option.folderPath)).toEqual(["Kept", "Elsewhere"]);
    expect(jobFolderOptions([])).toEqual([]);
  });

  // The wizard greys out "clear" for these: their files are not ours to remove, so the
  // instruction could only ever be ignored.
  it("says which libraries nothing can be cleared out of", () => {
    makeLibrary("EXT", { createdBy: "u1", type: "gallery", policyJson: EXTERNAL });
    photo("p1", "EXT", "Archive/one.jpg");
    expect(jobFolderOptions(["EXT"])[0]).toMatchObject({ folderPath: "Archive", isProtected: true });
  });
});

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
