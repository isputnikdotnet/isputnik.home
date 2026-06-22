import { describe, expect, it } from "vitest";
import {
  inferSeries,
  leadingPosition,
  cleanSeriesName,
  folderLooksLikeSeries
} from "../src/modules/library/shared/structure-inference.js";

describe("leadingPosition", () => {
  it("reads a leading ordinal, ignoring bare numbers", () => {
    expect(leadingPosition("1. Foo")).toBe(1);
    expect(leadingPosition("01) Bar")).toBe(1);
    expect(leadingPosition("13 - Baz")).toBe(13);
    expect(leadingPosition("Foo")).toBeUndefined();
    expect(leadingPosition("1984")).toBeUndefined();
  });
});

describe("cleanSeriesName", () => {
  it("strips a leading ordinal from a folder name", () => {
    expect(cleanSeriesName("1. Земля лишних")).toBe("Земля лишних");
    expect(cleanSeriesName("Ар-Деко")).toBe("Ар-Деко");
  });
});

describe("folderLooksLikeSeries", () => {
  it("needs 2+ numbered books that are the majority", () => {
    expect(folderLooksLikeSeries({ bookCount: 2, numberedBookCount: 2 })).toBe(true);
    expect(folderLooksLikeSeries({ bookCount: 3, numberedBookCount: 2 })).toBe(true); // one companion is fine
    expect(folderLooksLikeSeries({ bookCount: 2, numberedBookCount: 1 })).toBe(false);
    expect(folderLooksLikeSeries({ bookCount: 1, numberedBookCount: 0 })).toBe(false);
  });
});

describe("inferSeries", () => {
  const numberedPair = { bookCount: 2, numberedBookCount: 2 };

  it("uses in-file series first, with its index", () => {
    expect(inferSeries({ groupKey: "X/1. Foo", fileSeries: { name: "Foundation", index: 3 }, folder: numberedPair }))
      .toEqual({ series: "Foundation", position: 3, reason: "file-series" });
  });

  it("falls back to the filename position when in-file series has no index", () => {
    expect(inferSeries({ groupKey: "X/2. Foo", fileSeries: { name: "S" }, folder: numberedPair }))
      .toEqual({ series: "S", position: 2, reason: "file-series" });
  });

  it("infers a series from a numbered folder", () => {
    expect(inferSeries({ groupKey: "Ар-Деко/1. Ар-Деко", folder: numberedPair }))
      .toEqual({ series: "Ар-Деко", position: 1, reason: "numbered-folder" });
  });

  it("uses the immediate folder, skipping a universe layer", () => {
    expect(inferSeries({ groupKey: "ВСЕЛЕННАЯ/1. Земля лишних/1. Исход", folder: { bookCount: 3, numberedBookCount: 3 } }))
      .toEqual({ series: "Земля лишних", position: 1, reason: "numbered-folder" });
  });

  it("keeps an un-numbered companion in the series with no position", () => {
    expect(inferSeries({ groupKey: "Люди/Глоссарий", folder: { bookCount: 3, numberedBookCount: 2 } }))
      .toEqual({ series: "Люди", position: undefined, reason: "numbered-folder" });
  });

  it("treats a loose, non-numbered folder as standalone", () => {
    expect(inferSeries({ groupKey: "Сборники/Anthology", folder: { bookCount: 1, numberedBookCount: 0 } }))
      .toEqual({ reason: "standalone" });
  });

  it("treats a file at the library root as standalone", () => {
    expect(inferSeries({ groupKey: "Вне закона", folder: { bookCount: 5, numberedBookCount: 0 } }))
      .toEqual({ reason: "standalone" });
  });
});
