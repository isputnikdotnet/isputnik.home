// The risk gauge: the two confidence axes folded to one "how carefully should I look"
// reading. Folded on the server so every card folds it identically — and tested
// against the fold's one non-negotiable rule: byte-identical is risk zero no matter
// how arbitrary the keeper choice was, because identical copies are interchangeable.
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { createJob } from "../src/modules/library/gallery/duplicates/jobs.js";
import {
  assessResultRisk,
  keeperConfidenceOf,
  listJobResults,
  runJobScan
} from "../src/modules/library/gallery/duplicates/job-scan.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

describe("folding the two confidences into one risk reading", () => {
  it("byte-identical is risk zero even when the keeper was a coin toss", () => {
    // The case the CertaintyBadge comment calls completely safe and completely
    // uncertain at the same time. Safe is the answer that matters for the gauge.
    expect(assessResultRisk("exact", "certain", "tossup").severity).toBe(0);
    expect(assessResultRisk("exact", "certain", "evidence").severity).toBe(0);
  });

  it("climbs as the human evidence drains out of a perceptual match", () => {
    expect(assessResultRisk("near", "likely", "evidence").severity).toBe(1);
    expect(assessResultRisk("near", "likely", "guess").severity).toBe(2);
    expect(assessResultRisk("near", "likely", "tossup").severity).toBe(2);
  });

  it("tops out when the match itself is doubtful, whatever chose the keeper", () => {
    expect(assessResultRisk("near", "unsure", "evidence").severity).toBe(3);
    expect(assessResultRisk("near", "unsure", "guess").severity).toBe(3);
  });

  it("always hands the card a label and a sentence to show", () => {
    for (const tier of ["exact", "near"] as const) {
      for (const match of ["certain", "likely", "unsure"] as const) {
        for (const keeper of ["evidence", "guess", "tossup"] as const) {
          const risk = assessResultRisk(tier, match, keeper);
          expect(risk.label.length).toBeGreaterThan(0);
          expect(risk.explanation.length).toBeGreaterThan(20);
        }
      }
    }
  });
});

describe("what counts as evidence", () => {
  it("asks the keeper ladder, not a count of ranks", () => {
    // The regression this replaces: 'evidence' was 'rank < 5', which silently absorbed
    // the preview-copy criterion when it was inserted at rank 3 — a file property
    // graded as though it were a person's decision.
    expect(keeperConfidenceOf(0)).toBe("evidence"); // protected library
    expect(keeperConfidenceOf(1)).toBe("evidence"); // folder chosen to keep
    expect(keeperConfidenceOf(3)).toBe("guess");    // not a low-resolution copy
    expect(keeperConfidenceOf(4)).toBe("evidence"); // tags, albums or people
    expect(keeperConfidenceOf(5)).toBe("evidence"); // hand-edited details
    expect(keeperConfidenceOf(6)).toBe("guess");    // not a copy
    expect(keeperConfidenceOf(-1)).toBe("tossup");
  });
});

describe("the reading on a real result", () => {
  beforeEach(() => {
    resetDb();
    makeUser("u1", "admin");
    makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
    grant("group", EVERYONE_GROUP_ID, "GAL", "member");
  });

  it("arrives on the snapshot rows the card renders", () => {
    for (const [id, path] of [["a", "a.jpg"], ["b", "b.jpg"]]) {
      db.prepare(`
        INSERT INTO library_items (id, library_id, type, folder_path, status, discovered_at)
        VALUES (?, 'GAL', 'gallery', ?, 'ready', '2024-01-01T00:00:00.000Z')
      `).run(id, path);
      db.prepare(`
        INSERT INTO gallery_details (item_id, kind, relative_path, size, content_hash, content_hash_at, modified_at)
        VALUES (?, 'photo', ?, 1000, 'SAME-BYTES', 'm1', 'm1')
      `).run(id, path);
    }
    const created = createJob({ ownerUserId: "u1", libraryIds: ["GAL"], duplicateType: "files" });
    if (!created.ok) throw new Error("job refused");
    const done = runJobScan(created.job.id, "u1");
    if (!done.ok) throw new Error("scan refused");

    const result = listJobResults(created.job.id)[0];
    expect(result.risk).toMatchObject({ severity: 0, label: "No risk" });
    expect(result.risk.explanation).toContain("byte for byte");
  });
});
