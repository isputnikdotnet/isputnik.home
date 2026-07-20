import { describe, expect, it } from "vitest";
import { dateFolderForCapture, friendlyStorageError } from "../src/modules/library/gallery/routes.js";

describe("upload date-folder placement", () => {
  const uploadTime = new Date("2026-07-20T12:00:00Z");

  it("files by the embedded capture date (YYYY/YYYY-MM-DD), straight from the ISO prefix", () => {
    expect(dateFolderForCapture("2023-08-24T10:15:00.000Z", uploadTime)).toBe("2023/2023-08-24");
    // No timezone shift — the folder matches the ISO date even at day edges.
    expect(dateFolderForCapture("2019-01-01T23:59:00", uploadTime)).toBe("2019/2019-01-01");
  });

  it("falls back to the upload date when the file carries no embedded date", () => {
    expect(dateFolderForCapture(null, new Date("2026-03-05T09:00:00"))).toBe("2026/2026-03-05");
  });

  it("zero-pads month and day", () => {
    expect(dateFolderForCapture("2024-02-03T00:00:00Z", uploadTime)).toBe("2024/2024-02-03");
  });
});

describe("friendly storage errors", () => {
  it("explains a read-only / permission failure instead of a raw fs error", () => {
    const enoent = friendlyStorageError(new Error("ENOENT: no such file or directory, mkdir '/media/photos/.upload-x'"), "Upload failed");
    expect(enoent).toMatch(/Read\/Write/);
    expect(friendlyStorageError(new Error("EROFS: read-only file system, open '/media/x.jpg'"), "x")).toMatch(/write access/);
    expect(friendlyStorageError(new Error("EACCES: permission denied, rename '/a' -> '/b'"), "x")).toMatch(/Can't write/);
  });

  it("passes through unrelated errors unchanged", () => {
    expect(friendlyStorageError(new Error("Too many files — at most 200 per upload."), "x")).toBe("Too many files — at most 200 per upload.");
  });
});
