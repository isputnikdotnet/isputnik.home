// A library policy that omits maxUploadMB used to resolve to "no limit", letting
// one careless or compromised household account stream files until the disk
// filled. resolveUploadMaxBytes now applies a generous default instead. These pin
// that an unset policy is capped, and an explicit value still wins.
import { describe, expect, it } from "vitest";
import { resolveUploadMaxBytes, DEFAULT_MAX_UPLOAD_MB } from "../src/modules/library/shared/library-crud.js";

const MB = 1024 * 1024;

describe("resolveUploadMaxBytes", () => {
  it("caps an unset (null/undefined) policy at the default", () => {
    expect(resolveUploadMaxBytes(null)).toBe(DEFAULT_MAX_UPLOAD_MB * MB);
    expect(resolveUploadMaxBytes(undefined)).toBe(DEFAULT_MAX_UPLOAD_MB * MB);
  });

  it("honours an explicit per-library cap", () => {
    expect(resolveUploadMaxBytes(500)).toBe(500 * MB);
  });

  it("never resolves to unlimited", () => {
    expect(Number.isFinite(resolveUploadMaxBytes(null))).toBe(true);
  });
});
