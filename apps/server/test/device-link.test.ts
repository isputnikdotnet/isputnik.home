import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../src/db.js";
import { sha256 } from "../src/crypto.js";
import {
  approveLinkRequest,
  attachSession,
  createLinkRequest,
  denyLinkRequest,
  findPendingByUserCode,
  formatUserCode,
  noteFailedApproval,
  normalizeUserCode,
  pollLinkRequest,
  sweepLinkRequests,
  type LinkRequestRow
} from "../src/core/device-link.js";
import { makeUser, resetDb } from "./helpers/seed.js";

// The service behind linking a display. Most of what matters here is what happens
// when two things arrive at once or one arrives late, so the clock is moved by
// rewriting the row rather than by waiting.

function rowFor(id: string): LinkRequestRow {
  return db.prepare("SELECT * FROM device_link_requests WHERE id = ?").get(id) as LinkRequestRow;
}

function setExpiry(id: string, iso: string): void {
  db.prepare("UPDATE device_link_requests SET expires_at = ? WHERE id = ?").run(iso, id);
}

function minutesAway(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

beforeEach(() => {
  resetDb();
});

describe("code shapes", () => {
  it("draws a user code from the unambiguous alphabet, at a length you can read off a TV", () => {
    for (let i = 0; i < 50; i += 1) {
      const { userCode } = createLinkRequest();
      expect(userCode).toHaveLength(8);
      // No 0/O, no 1/I/L — the characters a reader across a room confuses.
      expect(userCode).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
    }
  });

  it("groups the code for display without changing what is stored", () => {
    const { id, userCode, userCodeDisplay } = createLinkRequest();
    expect(userCodeDisplay).toBe(`${userCode.slice(0, 4)}-${userCode.slice(4)}`);
    expect(rowFor(id).user_code).toBe(userCode);
  });

  it("accepts the code however it was typed", () => {
    expect(normalizeUserCode("k7m4-pq2n")).toBe("K7M4PQ2N");
    expect(normalizeUserCode(" K7M4 PQ2N ")).toBe("K7M4PQ2N");
    expect(normalizeUserCode("K7M4—PQ2N")).toBe("K7M4PQ2N");
  });

  it("formats an odd-length code without losing a character", () => {
    expect(formatUserCode("ABCDE")).toBe("ABC-DE");
  });

  it("gives every request its own codes", () => {
    const codes = new Set<string>();
    const devices = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      const made = createLinkRequest();
      codes.add(made.userCode);
      devices.add(made.deviceCode);
    }
    expect(codes.size).toBe(25);
    expect(devices.size).toBe(25);
  });
});

describe("createLinkRequest", () => {
  it("stores only the hash of the device code", () => {
    const { id, deviceCode } = createLinkRequest();
    const row = rowFor(id);
    expect(row.device_code_hash).toBe(sha256(deviceCode));
    expect(row.device_code_hash).not.toBe(deviceCode);
    expect(JSON.stringify(row)).not.toContain(deviceCode);
  });

  it("opens as pending, with a ten-minute window", () => {
    const { id } = createLinkRequest();
    const row = rowFor(id);
    expect(row.status).toBe("pending");
    const minutes = (Date.parse(row.expires_at) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(9);
    expect(minutes).toBeLessThanOrEqual(10);
  });

  it("records what the device said about itself, capped, and never trusts it for a name", () => {
    const { id } = createLinkRequest({ userAgent: "x".repeat(500), ip: "192.168.1.42" });
    const row = rowFor(id);
    expect(row.user_agent).toHaveLength(200);
    expect(row.ip_address).toBe("192.168.1.42");
    // There is no client-supplied name column at all: naming happens afterwards,
    // from the owner's own device list.
    expect(Object.keys(row)).not.toContain("device_name");
  });

  it("copes with a device that says nothing about itself", () => {
    const { id } = createLinkRequest();
    const row = rowFor(id);
    expect(row.user_agent).toBeNull();
    expect(row.ip_address).toBeNull();
  });
});

describe("findPendingByUserCode", () => {
  it("finds a live request, typed any way round", () => {
    const { id, userCode, userCodeDisplay } = createLinkRequest();
    expect(findPendingByUserCode(userCode)?.id).toBe(id);
    expect(findPendingByUserCode(userCodeDisplay)?.id).toBe(id);
    expect(findPendingByUserCode(userCode.toLowerCase())?.id).toBe(id);
  });

  it("returns nothing for a code that never existed", () => {
    expect(findPendingByUserCode("ZZZZZZZZ")).toBeNull();
    expect(findPendingByUserCode("")).toBeNull();
    expect(findPendingByUserCode("SHORT")).toBeNull();
  });

  it("returns nothing once the window has closed", () => {
    const { id, userCode } = createLinkRequest();
    setExpiry(id, minutesAway(-1));
    expect(findPendingByUserCode(userCode)).toBeNull();
  });

  it("returns nothing once the request has been answered", () => {
    makeUser("u1");
    const denied = createLinkRequest();
    denyLinkRequest(denied.id);
    expect(findPendingByUserCode(denied.userCode)).toBeNull();

    const approved = createLinkRequest();
    approveLinkRequest(approved.id, "u1");
    expect(findPendingByUserCode(approved.userCode)).toBeNull();
  });

  it("returns nothing once the confirmation screen has been talked to death", () => {
    const { id, userCode } = createLinkRequest();
    for (let i = 0; i < 4; i += 1) {
      expect(noteFailedApproval(id)).toBe(4 - i);
      expect(findPendingByUserCode(userCode)?.id).toBe(id);
    }
    expect(noteFailedApproval(id)).toBe(0);
    expect(findPendingByUserCode(userCode)).toBeNull();
  });
});

describe("approve / deny", () => {
  beforeEach(() => {
    makeUser("phone-owner");
    makeUser("someone-else");
  });

  it("records who approved it", () => {
    const { id } = createLinkRequest();
    expect(approveLinkRequest(id, "phone-owner")).toBe(true);
    const row = rowFor(id);
    expect(row.status).toBe("approved");
    expect(row.approved_by).toBe("phone-owner");
    expect(row.approved_at).toBeTruthy();
  });

  it("lets exactly one of two racing phones win", () => {
    const { id } = createLinkRequest();
    expect(approveLinkRequest(id, "phone-owner")).toBe(true);
    expect(approveLinkRequest(id, "someone-else")).toBe(false);
    expect(rowFor(id).approved_by).toBe("phone-owner");
  });

  it("refuses to approve a request that expired while the screen was open", () => {
    const { id } = createLinkRequest();
    setExpiry(id, minutesAway(-1));
    expect(approveLinkRequest(id, "phone-owner")).toBe(false);
    expect(rowFor(id).status).toBe("pending");
  });

  it("refuses to approve one that was already denied", () => {
    const { id } = createLinkRequest();
    expect(denyLinkRequest(id)).toBe(true);
    expect(approveLinkRequest(id, "phone-owner")).toBe(false);
    expect(rowFor(id).status).toBe("denied");
  });

  it("denies without needing the request to be fresh-minted, but only once", () => {
    const { id } = createLinkRequest();
    expect(denyLinkRequest(id)).toBe(true);
    expect(denyLinkRequest(id)).toBe(false);
  });
});

describe("pollLinkRequest", () => {
  beforeEach(() => {
    makeUser("phone-owner");
  });

  it("says pending while nobody has answered", () => {
    const { deviceCode } = createLinkRequest();
    expect(pollLinkRequest(deviceCode)).toEqual({ status: "pending" });
  });

  it("distinguishes a code that never existed from one that ran out", () => {
    // The difference matters: 'unknown' is a guess and is counted against the
    // caller's IP; 'expired' is a display that sat unattended and is not.
    expect(pollLinkRequest("not-a-real-device-code")).toEqual({ status: "unknown" });
    expect(pollLinkRequest("")).toEqual({ status: "unknown" });

    const { id, deviceCode } = createLinkRequest();
    setExpiry(id, minutesAway(-1));
    expect(pollLinkRequest(deviceCode)).toEqual({ status: "expired" });
  });

  it("stops a denied device rather than leaving it spinning", () => {
    const { id, deviceCode } = createLinkRequest();
    denyLinkRequest(id);
    expect(pollLinkRequest(deviceCode)).toEqual({ status: "denied" });
  });

  it("hands the approval to exactly one poll, and claims it in the same breath", () => {
    const { id, deviceCode } = createLinkRequest();
    approveLinkRequest(id, "phone-owner");

    const first = pollLinkRequest(deviceCode);
    expect(first.status).toBe("approved");
    expect(first.status === "approved" && first.row.approved_by).toBe("phone-owner");
    // Claimed: the row is spent even though no session exists yet.
    expect(rowFor(id).status).toBe("consumed");

    // A second poll — a retry, a duplicated request, a copy of the device code —
    // gets nothing.
    expect(pollLinkRequest(deviceCode)).toEqual({ status: "consumed" });
  });

  it("still honours an approval that landed just before the window closed", () => {
    const { id, deviceCode } = createLinkRequest();
    approveLinkRequest(id, "phone-owner");
    // The original ten minutes are gone, but the approval is seconds old: the
    // device is only collecting what it was already granted.
    setExpiry(id, minutesAway(-1));
    expect(pollLinkRequest(deviceCode).status).toBe("approved");
  });

  it("will not hand over an approval nobody collected", () => {
    const { id, deviceCode } = createLinkRequest();
    approveLinkRequest(id, "phone-owner");
    db.prepare("UPDATE device_link_requests SET approved_at = ? WHERE id = ?").run(minutesAway(-6), id);
    expect(pollLinkRequest(deviceCode)).toEqual({ status: "expired" });
    // And it stays uncollectable rather than being quietly claimed.
    expect(rowFor(id).status).toBe("approved");
  });
});

describe("attachSession", () => {
  it("ties a redeemed request to the session it became", () => {
    makeUser("phone-owner");
    const { id, deviceCode } = createLinkRequest();
    approveLinkRequest(id, "phone-owner");
    pollLinkRequest(deviceCode);

    db.prepare(
      "INSERT INTO sessions (id, token_hash, user_id, expires_at, kind) VALUES ('sess1', 'h', 'phone-owner', ?, 'device')"
    ).run(minutesAway(60));
    attachSession(id, "sess1");

    expect(rowFor(id).session_id).toBe("sess1");
  });

  it("lets go of the link when the session is revoked and cleaned up, keeping the audit row", () => {
    makeUser("phone-owner");
    const { id } = createLinkRequest();
    db.prepare(
      "INSERT INTO sessions (id, token_hash, user_id, expires_at) VALUES ('sess1', 'h', 'phone-owner', ?)"
    ).run(minutesAway(60));
    attachSession(id, "sess1");

    db.prepare("DELETE FROM sessions WHERE id = 'sess1'").run();
    expect(rowFor(id).session_id).toBeNull();
  });
});

describe("sweepLinkRequests", () => {
  it("clears out what is long over and leaves everything else", () => {
    const live = createLinkRequest();
    const justExpired = createLinkRequest();
    const ancient = createLinkRequest();
    setExpiry(justExpired.id, minutesAway(-5));
    setExpiry(ancient.id, minutesAway(-90));

    expect(sweepLinkRequests()).toBe(1);
    expect(rowFor(ancient.id)).toBeUndefined();
    expect(rowFor(justExpired.id)).toBeTruthy();
    expect(rowFor(live.id)).toBeTruthy();
  });

  it("is a no-op on a quiet house", () => {
    expect(sweepLinkRequests()).toBe(0);
  });
});
