import { describe, expect, it } from "vitest";
import {
  backFileNameFor,
  backRuleOf,
  frontStemsFor,
  matchBackPattern,
  pairBackSides,
  splitFileNameFor,
  type BackRule
} from "../src/modules/library/gallery/back-sides.js";
import {
  enabledBackPatterns,
  isValidBackPattern,
  normalizeBackSides
} from "../src/modules/library/shared/library-settings.js";

const photo = (relativePath: string) => ({ relativePath, kind: "photo" as const });
const EPSON: BackRule = { patterns: ["{name}_b"], epsonTwin: true };
const NAMED: BackRule = { patterns: ["{name}_back", "{name}-back", "{name}.back"], epsonTwin: false };

describe("back pattern matching", () => {
  it("names the front's stem, ignoring case, keeping the file's own spelling", () => {
    expect(matchBackPattern("IMG_0012_b", "{name}_b")).toBe("IMG_0012");
    expect(matchBackPattern("IMG_0012_B", "{name}_b")).toBe("IMG_0012");
    expect(matchBackPattern("back_IMG_0012", "back_{name}")).toBe("IMG_0012");
    expect(matchBackPattern("IMG_0012", "{name}_b")).toBeNull();
    // Nothing left for the name itself.
    expect(matchBackPattern("_b", "{name}_b")).toBeNull();
  });

  it("validates custom patterns the way a file name needs", () => {
    expect(isValidBackPattern("{name}_verso")).toBe(true);
    expect(isValidBackPattern("verso {name}")).toBe(true);
    expect(isValidBackPattern("{name}")).toBe(false);
    expect(isValidBackPattern("{name}{name}_b")).toBe(false);
    expect(isValidBackPattern("{name}/b")).toBe(false);
    expect(isValidBackPattern("x")).toBe(false);
    expect(isValidBackPattern(42)).toBe(false);
  });
});

describe("back_sides settings", () => {
  it("defaults to every source off and no patterns", () => {
    const settings = normalizeBackSides(undefined);
    expect(settings.sources.map((s) => `${s.id}:${s.enabled}`)).toEqual(["epson:false", "named:false", "custom:false"]);
    expect(settings.patterns).toEqual([]);
    expect(enabledBackPatterns(settings)).toEqual([]);
  });

  it("keeps the stored order, appends missing sources off and drops bad patterns", () => {
    const settings = normalizeBackSides({
      sources: [{ id: "custom", enabled: true }, { id: "epson", enabled: true }, { id: "bogus", enabled: true }],
      patterns: ["{name}_verso", "{NAME}_VERSO", "{name}", "nope"]
    });
    expect(settings.sources.map((s) => s.id)).toEqual(["custom", "epson", "named"]);
    expect(settings.patterns).toEqual(["{name}_verso"]);
    expect(enabledBackPatterns(settings)).toEqual(["{name}_verso", "{name}_b"]);
    expect(backRuleOf(settings)).toEqual({ patterns: ["{name}_verso", "{name}_b"], epsonTwin: true });
  });
});

describe("pairing a folder of files", () => {
  it("pairs an Epson triplet: the back attaches to the raw scan, the _a copy stays a photo", () => {
    const pairing = pairBackSides([
      photo("Box/OldImgScan_0015.jpg"),
      photo("Box/OldImgScan_0015_a.jpg"),
      photo("Box/OldImgScan_0015_b.jpg"),
      photo("Box/OldImgScan_0016.jpg"),
      photo("Box/OldImgScan_0016_a.jpg")
    ], EPSON);
    expect(pairing.backOf.get("Box/OldImgScan_0015.jpg")).toBe("Box/OldImgScan_0015_b.jpg");
    expect(pairing.backs).toEqual(new Set(["Box/OldImgScan_0015_b.jpg"]));
    expect(pairing.backOf.has("Box/OldImgScan_0015_a.jpg")).toBe(false);
    expect(pairing.unmatched).toEqual([]);
  });

  it("falls back to the _a twin when the raw scan is gone, under the Epson rule only", () => {
    const files = [photo("OldImgScan_0015_a.jpg"), photo("OldImgScan_0015_b.jpg")];
    expect(pairBackSides(files, EPSON).backOf.get("OldImgScan_0015_a.jpg")).toBe("OldImgScan_0015_b.jpg");
    const noTwin = pairBackSides(files, { patterns: ["{name}_b"], epsonTwin: false });
    expect(noTwin.backs.size).toBe(0);
    expect(noTwin.unmatched).toEqual(["OldImgScan_0015_b.jpg"]);
  });

  it("leaves a back with no front, a back in another folder and a non-photo alone", () => {
    const pairing = pairBackSides([
      photo("a/X.jpg"),
      photo("b/X_b.jpg"),
      photo("a/Y_b.jpg"),
      { relativePath: "a/Z.mp4", kind: "video" },
      photo("a/Z_b.jpg")
    ], EPSON);
    expect(pairing.backs.size).toBe(0);
    expect(pairing.unmatched.sort()).toEqual(["a/Y_b.jpg", "a/Z_b.jpg", "b/X_b.jpg"]);
  });

  it("tries patterns in order and gives a front one back only", () => {
    const pairing = pairBackSides([
      photo("X.jpg"),
      photo("X-back.jpg"),
      photo("X_back.jpg")
    ], NAMED);
    expect(pairing.backOf.get("X.jpg")).toBe("X_back.jpg");
    expect(pairing.backs).toEqual(new Set(["X_back.jpg"]));
    // The loser stays an ordinary photo.
    expect(pairing.unmatched).toEqual(["X-back.jpg"]);
  });

  it("never lets a back be a front", () => {
    const pairing = pairBackSides([photo("X.jpg"), photo("X_b.jpg"), photo("X_b_b.jpg")], EPSON);
    expect(pairing.backOf.get("X.jpg")).toBe("X_b.jpg");
    expect(pairing.backOf.has("X_b.jpg")).toBe(false);
    expect(pairing.unmatched).toEqual(["X_b_b.jpg"]);
  });

  it("does nothing with no pattern on", () => {
    const pairing = pairBackSides([photo("X.jpg"), photo("X_b.jpg")], { patterns: [], epsonTwin: false });
    expect(pairing.backs.size).toBe(0);
    expect(pairing.unmatched).toEqual([]);
  });
});

describe("naming", () => {
  it("names a hand-added back with the library's first pattern, else _back", () => {
    expect(backFileNameFor("IMG_0012.JPG", EPSON, "jpeg")).toBe("IMG_0012_b.jpeg");
    expect(backFileNameFor("IMG_0012.jpg", { patterns: [], epsonTwin: false }, ".PNG")).toBe("IMG_0012_back.png");
    expect(backFileNameFor("Granny 1949.jpg", { patterns: ["verso {name}"], epsonTwin: false }, "jpg")).toBe("verso Granny 1949.jpg");
  });

  it("splits off under a name no pattern recognises", () => {
    expect(splitFileNameFor("IMG_0012.jpg", "IMG_0012_b.jpg")).toBe("IMG_0012 (back).jpg");
    expect(matchBackPattern("IMG_0012 (back)", "{name}_b")).toBeNull();
    expect(matchBackPattern("IMG_0012 (back)", "{name}_back")).toBeNull();
  });

  it("lists the fronts a lone back could belong to, twin included", () => {
    expect(frontStemsFor("2024/IMG_0012_b.jpg", EPSON)).toEqual(["IMG_0012", "IMG_0012_a"]);
    expect(frontStemsFor("2024/IMG_0012.jpg", EPSON)).toEqual([]);
  });
});
