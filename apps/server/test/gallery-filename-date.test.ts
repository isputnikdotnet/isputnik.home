import { describe, expect, it } from "vitest";
import { dateFromFileName } from "../src/modules/library/gallery/filename-date.js";

// The parser builds local-time dates (like EXIF's naive timestamps), so assert on
// local parts rather than the ISO string — otherwise these pass only in UTC.
function parts(iso: string | null) {
  expect(iso).not.toBeNull();
  const d = new Date(iso!);
  return {
    date: [d.getFullYear(), d.getMonth() + 1, d.getDate()].join("-"),
    time: [d.getHours(), d.getMinutes(), d.getSeconds()].join(":")
  };
}

describe("date from filename — the shapes photos actually arrive in", () => {
  it("reads the delimited ISO-ish form, with and without a time", () => {
    // The case that started this: a metadata-stripped 2012 photo whose mtime was
    // rewritten to 2025 by a sync.
    expect(parts(dateFromFileName("2012-12-02T16-38-20_3.jpg")))
      .toEqual({ date: "2012-12-2", time: "16:38:20" });
    expect(parts(dateFromFileName("2012-12-02 16.38.20.jpg")))
      .toEqual({ date: "2012-12-2", time: "16:38:20" });
    expect(parts(dateFromFileName("Screenshot_2012-12-02-16-38-20.png")))
      .toEqual({ date: "2012-12-2", time: "16:38:20" });
    expect(parts(dateFromFileName("2012-12-02.jpg")))
      .toEqual({ date: "2012-12-2", time: "0:0:0" });
  });

  it("reads the compact forms phones and exporters use", () => {
    expect(parts(dateFromFileName("IMG_20121202_163820.jpg")))
      .toEqual({ date: "2012-12-2", time: "16:38:20" });
    expect(parts(dateFromFileName("VID_20121202_163820.mp4")))
      .toEqual({ date: "2012-12-2", time: "16:38:20" });
    // Pixel names carry sub-second digits after the time.
    expect(parts(dateFromFileName("PXL_20121202_163820123.jpg")))
      .toEqual({ date: "2012-12-2", time: "16:38:20" });
    // WhatsApp: date only, then a sequence number.
    expect(parts(dateFromFileName("IMG-20121202-WA0001.jpg")))
      .toEqual({ date: "2012-12-2", time: "0:0:0" });
  });

  it("keeps the date when the time in the name is nonsense", () => {
    expect(parts(dateFromFileName("2012-12-02T99-99-99.jpg")))
      .toEqual({ date: "2012-12-2", time: "0:0:0" });
  });
});

describe("date from filename — refusing to guess", () => {
  it("rejects dates that never existed", () => {
    expect(dateFromFileName("2012-02-30.jpg")).toBeNull();
    expect(dateFromFileName("2012-13-01.jpg")).toBeNull();
    expect(dateFromFileName("IMG_20120230_120000.jpg")).toBeNull();
  });

  it("rejects implausible years", () => {
    expect(dateFromFileName("1887-05-01.jpg")).toBeNull();
    const farFuture = new Date().getUTCFullYear() + 5;
    expect(dateFromFileName(`${farFuture}-05-01.jpg`)).toBeNull();
  });

  it("does not find a date inside a longer number", () => {
    expect(dateFromFileName("123420121202567890.jpg")).toBeNull();
    expect(dateFromFileName("DSC_00012012.jpg")).toBeNull();
  });

  it("returns null for names with no date at all", () => {
    expect(dateFromFileName("DSC_0042.jpg")).toBeNull();
    expect(dateFromFileName("holiday.jpg")).toBeNull();
    expect(dateFromFileName("")).toBeNull();
    expect(dateFromFileName(".jpg")).toBeNull();
  });

  it("ignores a date-shaped extension and reads only the basename", () => {
    expect(parts(dateFromFileName("2012-12-02.20240101"))).toEqual({ date: "2012-12-2", time: "0:0:0" });
  });
});
