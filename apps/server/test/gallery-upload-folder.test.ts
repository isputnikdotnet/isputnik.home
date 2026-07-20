import { describe, expect, it } from "vitest";
import { dateFolderForCapture } from "../src/modules/library/gallery/routes.js";

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
