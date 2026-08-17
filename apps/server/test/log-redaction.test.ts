import { describe, expect, it } from "vitest";
import { maskLogUrl } from "../src/core/log-redaction.js";

describe("maskLogUrl", () => {
  it("masks the OPDS feed token", () => {
    expect(maskLogUrl("/opds/isp_abc123def456/new")).toBe("/opds/<token>/new");
  });

  it("masks a guest share token but keeps the sub-path", () => {
    expect(maskLogUrl("/api/share/s3cr3ttoken/items/xyz/file")).toBe("/api/share/<token>/items/xyz/file");
    expect(maskLogUrl("/api/share/s3cr3ttoken/download-all")).toBe("/api/share/<token>/download-all");
    expect(maskLogUrl("/api/share/s3cr3ttoken")).toBe("/api/share/<token>");
  });

  it("masks an invite token, with or without the /accept suffix", () => {
    expect(maskLogUrl("/api/invites/inv-t0ken")).toBe("/api/invites/<token>");
    expect(maskLogUrl("/api/invites/inv-t0ken/accept")).toBe("/api/invites/<token>/accept");
  });

  it("masks the browser-facing SPA share/invite routes (the most-logged case)", () => {
    // A guest navigation to /share/<token> hits the SPA fallback and is logged.
    expect(maskLogUrl("/share/s3cr3ttoken")).toBe("/share/<token>");
    expect(maskLogUrl("/share/s3cr3ttoken/items/x")).toBe("/share/<token>/items/x");
    expect(maskLogUrl("/invite/inv-t0ken")).toBe("/invite/<token>");
  });

  it("leaves the owner's plural /api/shares routes alone", () => {
    // The guest prefix is singular /api/share/; /api/shares/ carries item ids and
    // library-scoped data, not a bearer token, so it must stay readable.
    expect(maskLogUrl("/api/shares/mine")).toBe("/api/shares/mine");
    expect(maskLogUrl("/api/shares/set/user")).toBe("/api/shares/set/user");
  });

  it("preserves a query string after the token", () => {
    expect(maskLogUrl("/api/share/tok?download=1")).toBe("/api/share/<token>?download=1");
  });

  it("leaves ordinary paths untouched", () => {
    expect(maskLogUrl("/api/library/books/abc/cover")).toBe("/api/library/books/abc/cover");
    expect(maskLogUrl("/control/security/blocked-ips")).toBe("/control/security/blocked-ips");
  });
});
