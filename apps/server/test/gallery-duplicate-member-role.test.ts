// Overruling the scan about one copy of a photo set.
//
// Everything else in job-review is a note ABOUT a result, and apply-preferences
// re-runs the scan rather than editing keepers. This is the one place a person's
// answer is written straight into the snapshot, so the rules that keep it safe are
// worth pinning down: a set always keeps something, a protected copy is never a
// choice, and a near-identical set never comes to claim identical pixels.
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { createJob } from "../src/modules/library/gallery/duplicates/jobs.js";
import {
  runJobScan, listJobResults, sweepPreview, sweepableResultIds
} from "../src/modules/library/gallery/duplicates/job-scan.js";
import { setMemberRole } from "../src/modules/library/gallery/duplicates/job-review.js";
import { checkResult, resolveJobResult } from "../src/modules/library/gallery/duplicates/job-resolve.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

function asset(id: string, relativePath: string, hash: string, library = "GAL"): string {
  db.prepare(`
    INSERT INTO library_items (id, library_id, type, folder_path, status, discovered_at)
    VALUES (?, ?, 'gallery', ?, 'ready', '2024-01-01T00:00:00.000Z')
  `).run(id, library, relativePath);
  db.prepare(`
    INSERT INTO gallery_details (item_id, kind, relative_path, size, content_hash, content_hash_at, modified_at)
    VALUES (?, 'photo', ?, 1000, ?, 'm1', 'm1')
  `).run(id, relativePath, hash);
  return id;
}

const startJob = (libraries = ["GAL"], duplicateType: "folders" | "files" = "files") => {
  const created = createJob({ ownerUserId: "u1", libraryIds: libraries, duplicateType });
  if (!created.ok) throw new Error(`job refused: ${created.refused}`);
  const done = runJobScan(created.job.id, "u1");
  if (!done.ok) throw new Error(`scan refused: ${done.refused}`);
  return created.job.id;
};

/** Two copies of one picture. The scan settles which is kept; the tests take that as
 *  found rather than assuming, since the keeper ladder is not this file's subject. */
const twoCopies = () => {
  asset("a1", "Album/one.jpg", "same");
  asset("a2", "Downloads/one.jpg", "same");
  const jobId = startJob();
  const result = listJobResults(jobId)[0];
  const kept = result.members.find((member) => member.role === "keep")!;
  const doomed = result.members.find((member) => member.role === "delete")!;
  return { jobId, result, kept, doomed };
};

const rolesOf = (resultId: string) =>
  db.prepare("SELECT id, role, distance, keeper_member_id FROM duplicate_job_result_members WHERE result_id = ? ORDER BY path")
    .all(resultId) as { id: string; role: string; distance: number; keeper_member_id: string | null }[];

beforeEach(() => {
  resetDb();
  makeUser("u1", "admin");
  makeUser("u2", "admin");
  makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
  // Somewhere the app may only read, so nothing in it is ever a copy to delete.
  makeLibrary("READONLY", { createdBy: "u1", type: "gallery", policyJson: '{"mode":"external"}' });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
  grant("group", EVERYONE_GROUP_ID, "READONLY", "member");
});

describe("changing which copy survives", () => {
  it("keeps a copy the scan had marked for deletion", () => {
    const { jobId, result, doomed } = twoCopies();
    expect(setMemberRole(jobId, "u1", result.id, doomed.id, "keep").ok).toBe(true);

    const after = listJobResults(jobId)[0];
    expect(after.members.find((member) => member.id === doomed.id)!.role).toBe("keep");
    // Both copies kept now, so the set would free nothing — and says so.
    expect(after.members.every((member) => member.role === "keep")).toBe(true);
    expect(after.reclaimableBytes).toBe(0);
  });

  it("lets the scan's keeper go once another copy is kept", () => {
    const { jobId, result, kept, doomed } = twoCopies();
    expect(setMemberRole(jobId, "u1", result.id, doomed.id, "keep").ok).toBe(true);
    expect(setMemberRole(jobId, "u1", result.id, kept.id, "delete").ok).toBe(true);

    const after = listJobResults(jobId)[0];
    expect(after.members.find((member) => member.id === kept.id)!.role).toBe("delete");
    expect(after.members.find((member) => member.id === doomed.id)!.role).toBe("keep");
    expect(after.reclaimableBytes).toBe(1000);
  });

  // One click moves ONE copy. Nothing else in the set follows it, and no combination is
  // out of bounds — including keeping none, which is a set of copies of something
  // nobody wants.
  it("moves only the copy that was clicked", () => {
    asset("b1", "One/two.jpg", "other");
    asset("b2", "Two/two.jpg", "other");
    asset("b3", "Three/two.jpg", "other");
    const jobId = startJob();
    const result = listJobResults(jobId).find((entry) => entry.members.length === 3)!;
    const [first, second, third] = result.members;

    setMemberRole(jobId, "u1", result.id, second.id, second.role === "keep" ? "delete" : "keep");

    const after = listJobResults(jobId).find((entry) => entry.id === result.id)!;
    const roleOf = (id: string) => after.members.find((member) => member.id === id)!.role;
    expect(roleOf(first.id)).toBe(first.role);
    expect(roleOf(third.id)).toBe(third.role);
    expect(roleOf(second.id)).not.toBe(second.role);
  });

  it("lets every copy be marked for deletion", () => {
    const { jobId, result, kept } = twoCopies();
    expect(setMemberRole(jobId, "u1", result.id, kept.id, "delete").ok).toBe(true);

    const rows = rolesOf(result.id);
    expect(rows.every((row) => row.role === "delete")).toBe(true);
    // Both copies are leaving, so neither is promised as anyone's survivor.
    expect(rows.every((row) => row.keeper_member_id === null)).toBe(true);
    // And the set now offers both copies' bytes back, not one's.
    expect(listJobResults(jobId)[0].reclaimableBytes).toBe(2000);
  });

  // With nothing kept there is no copy to say "kept because" about.
  it("drops the keeper reason when nothing is kept", () => {
    const { jobId, result, kept } = twoCopies();
    setMemberRole(jobId, "u1", result.id, kept.id, "delete");
    expect(listJobResults(jobId)[0].keeperReason).toBeNull();
  });

  it("points the doomed copies at the copy that will survive them", () => {
    const { jobId, result, kept, doomed } = twoCopies();
    setMemberRole(jobId, "u1", result.id, doomed.id, "keep");
    setMemberRole(jobId, "u1", result.id, kept.id, "delete");

    const rows = rolesOf(result.id);
    const survivor = rows.find((row) => row.role === "keep")!;
    expect(survivor.id).toBe(doomed.id);
    expect(survivor.keeper_member_id).toBeNull();
    // Every doomed row names the survivor — not the copy the scan originally chose.
    expect(rows.filter((row) => row.role === "delete").map((row) => row.keeper_member_id))
      .toEqual([doomed.id]);
  });

  // End to end, and the assertion that matters: a resolve must hand the doomed copy's
  // hand-filed work to the copy the PERSON chose. trashBook needs a real library folder
  // so the file itself cannot go in here, but the handover happens before it and is
  // what would be lost if keeper_member_id were left pointing at the old keeper.
  it("hands tags to the copy the person chose, not the one the scan proposed", () => {
    const { jobId, result, kept, doomed } = twoCopies();
    db.prepare("INSERT INTO tags (id, key, display_name) VALUES ('t1', 'trips', 'Trips')").run();
    db.prepare("INSERT INTO taggables (tag_id, entity_type, entity_id) VALUES ('t1', 'library_item', ?)")
      .run(kept.itemId);

    setMemberRole(jobId, "u1", result.id, doomed.id, "keep");
    setMemberRole(jobId, "u1", result.id, kept.id, "delete");
    resolveJobResult(jobId, "u1", result.id);

    const tagged = db.prepare("SELECT entity_id FROM taggables WHERE tag_id = 't1'")
      .all() as { entity_id: string }[];
    expect(tagged.map((row) => row.entity_id)).toContain(doomed.itemId);
  });

  // Two copies in the read-only library on purpose: the keeper ladder puts a protected
  // copy first, so one of them takes the keep slot and the OTHER is the 'protected' row
  // — a copy that is shown but was never on offer.
  it("refuses a copy in a library the app may only read", () => {
    asset("a1", "Album/one.jpg", "same");
    asset("r1", "Kept/one.jpg", "same", "READONLY");
    asset("r2", "AlsoKept/one.jpg", "same", "READONLY");
    const jobId = startJob(["GAL", "READONLY"]);
    const result = listJobResults(jobId)[0];
    const guarded = result.members.find((member) => member.role === "protected")!;

    expect(setMemberRole(jobId, "u1", result.id, guarded.id, "delete"))
      .toMatchObject({ ok: false, refused: "member_protected" });
    // And it stays exactly as it was — protection is not a decision to overrule.
    expect(listJobResults(jobId)[0].members.find((member) => member.id === guarded.id)!.role)
      .toBe("protected");
  });

  it("refuses on a folder result, whose offer is about the folder", () => {
    asset("t1", "test/one.jpg", "pic-1");
    asset("t2", "test/two.jpg", "pic-2");
    asset("f1", "One/one.jpg", "pic-1");
    asset("f2", "Two/two.jpg", "pic-2");
    const jobId = startJob(["GAL"], "folders");
    const folderResult = listJobResults(jobId).find((entry) => entry.type !== "photo_set")!;

    expect(setMemberRole(jobId, "u1", folderResult.id, folderResult.members[0].id, "keep"))
      .toMatchObject({ ok: false, refused: "not_a_photo_set" });
  });

  it("is only for the owner", () => {
    const { jobId, result, doomed } = twoCopies();
    expect(setMemberRole(jobId, "u2", result.id, doomed.id, "keep"))
      .toMatchObject({ ok: false, refused: "not_owner" });
  });

  it("is refused once the job is finished", () => {
    const { jobId, result, doomed } = twoCopies();
    db.prepare("UPDATE duplicate_jobs SET status = 'completed' WHERE id = ?").run(jobId);
    expect(setMemberRole(jobId, "u1", result.id, doomed.id, "keep"))
      .toMatchObject({ ok: false, refused: "not_reviewable" });
  });
});

// Keeping nothing is allowed, so the paths that assumed a survivor have to cope: the
// re-check must not call a deliberately keeper-less row stale, the resolve must skip
// the hand-over rather than refuse, and the bulk sweep must not quietly carry out a
// decision whose whole point is that it removes the last copy.
describe("a set that keeps nothing", () => {
  const keepNothing = () => {
    const { jobId, result, kept } = twoCopies();
    setMemberRole(jobId, "u1", result.id, kept.id, "delete");
    return { jobId, result };
  };

  it("passes the re-check rather than reading as a broken snapshot", () => {
    const { jobId, result } = keepNothing();
    const check = checkResult(jobId, result.id)!;
    expect(check.ok).toBe(true);
    expect(check.problems).toEqual([]);
  });

  // The copies still go. What does NOT happen is a hand-over: there is nobody to
  // inherit, so the tags leave with the photographs rather than landing on a copy that
  // is itself on its way out.
  it("carries the deletion out with no copy to hand work to", () => {
    const { jobId, result } = keepNothing();
    const outcome = resolveJobResult(jobId, "u1", result.id);
    if (!outcome.ok) throw new Error(`expected the resolve to run, got ${outcome.refused}`);
    // trashBook needs a real library folder, so in here each copy reports why it could
    // not go — the point is that none was refused for want of a keeper.
    expect(outcome.job.failed.map((entry) => entry.error))
      .not.toContain("No surviving copy is recorded for this photo.");
  });

  it("is left out of the sweep, which promises every copy has a survivor", () => {
    const { jobId } = keepNothing();
    expect(sweepPreview(jobId)).toMatchObject({ results: 0, copies: 0, bytes: 0 });
    expect(sweepableResultIds(jobId)).toEqual([]);
  });

  // The exclusion has to be surgical: one set opting out must not take the rest of the
  // sweep with it. Two sets from one scan, one of them emptied of keepers.
  it("still sweeps the sets that DO keep something", () => {
    asset("a1", "Album/one.jpg", "same");
    asset("a2", "Downloads/one.jpg", "same");
    asset("c1", "Album/three.jpg", "third");
    asset("c2", "Downloads/three.jpg", "third");
    const jobId = startJob();
    const results = listJobResults(jobId);
    expect(results).toHaveLength(2);

    const [emptied, untouched] = results;
    setMemberRole(jobId, "u1", emptied.id, emptied.members.find((m) => m.role === "keep")!.id, "delete");

    const sweepable = sweepableResultIds(jobId);
    expect(sweepable).not.toContain(emptied.id);
    expect(sweepable).toContain(untouched.id);
    expect(sweepPreview(jobId).results).toBe(1);
  });
});

// Distance is measured FROM the keeper, and resolve reads exactly one thing from it:
// face boxes move only at 0, because identical bytes mean identical pixels. Moving the
// keeper therefore has to leave every other copy of a near set above 0, or a re-framed
// photograph would collect rectangles drawn on a different picture.
describe("a near-identical set after the keeper moves", () => {
  const nearPair = () => {
    const { jobId, result, kept, doomed } = twoCopies();
    // What the near tier records: the non-keeper sits some bits off the keeper.
    db.prepare("UPDATE duplicate_job_result_members SET distance = 2 WHERE id = ?").run(doomed.id);
    return { jobId, result, kept, doomed };
  };

  it("never leaves a doomed copy claiming identical pixels", () => {
    const { jobId, result, kept, doomed } = nearPair();
    setMemberRole(jobId, "u1", result.id, doomed.id, "keep");
    setMemberRole(jobId, "u1", result.id, kept.id, "delete");

    const rows = rolesOf(result.id);
    expect(rows.filter((row) => row.role === "delete").every((row) => row.distance > 0)).toBe(true);
  });

  it("stays a near-identical set rather than turning into an identical one", () => {
    const { jobId, result, kept, doomed } = nearPair();
    setMemberRole(jobId, "u1", result.id, doomed.id, "keep");
    setMemberRole(jobId, "u1", result.id, kept.id, "delete");
    // listJobResults derives the tier from these same distances, so the card keeps
    // saying "these only look alike" — the warning is not lost with the keeper.
    expect(listJobResults(jobId)[0].tier).toBe("near");
  });

  it("leaves a byte-identical set identical", () => {
    const { jobId, result, kept, doomed } = twoCopies();
    setMemberRole(jobId, "u1", result.id, doomed.id, "keep");
    setMemberRole(jobId, "u1", result.id, kept.id, "delete");
    expect(rolesOf(result.id).every((row) => row.distance === 0)).toBe(true);
    expect(listJobResults(jobId)[0].tier).toBe("exact");
  });
});
