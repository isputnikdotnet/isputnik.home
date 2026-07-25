import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock only the transport; isMailConfigured stays real and reads the in-memory
// app_settings, which is the guard every alert goes through.
vi.mock("../src/core/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/mail.js")>();
  return { ...actual, sendMail: vi.fn(async () => {}) };
});

import { db, logActivity, type User } from "../src/db.js";
import { sendMail } from "../src/core/mail.js";
import {
  alertEmailChanged,
  alertMfaBackupCodesRegenerated,
  alertMfaEnabled,
  alertMfaFailures,
  alertPasswordChanged
} from "../src/core/security-alerts.js";
import { MFA_FAILURE_ALERT_THRESHOLD, recentMfaFailureCount } from "../src/core/security.js";
import { makeUser, resetDb } from "./helpers/seed.js";

// The alerts are fire-and-forget (`void notify(…)`), so let the microtask queue
// drain before asserting.
const flush = () => new Promise((resolve) => setImmediate(resolve));

function configureMail(): void {
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('mail_settings', ?)").run(
    JSON.stringify({
      host: "smtp.test",
      port: 587,
      secure: false,
      username: "",
      password: "",
      fromAddress: "home@test.local",
      fromName: "Home"
    })
  );
}

function getUser(userId: string): User {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as User;
}

function recipients(): string[][] {
  return vi.mocked(sendMail).mock.calls.map((call) => call[0].to.split(", "));
}

function bodies(): string[] {
  return vi.mocked(sendMail).mock.calls.map((call) => call[0].text);
}

// Each test uses its own account: the alert throttle is a module-level map that
// isn't reset between tests, and it's keyed on the account.
let seq = 0;
function freshUser(role: "admin" | "member" = "member"): User {
  seq += 1;
  return getUser(makeUser(`u${seq}`, role));
}

beforeEach(() => {
  resetDb();
  vi.clearAllMocks();
  configureMail();
});

describe("account-security change alerts", () => {
  it("sends nothing at all when SMTP isn't configured", async () => {
    db.prepare("DELETE FROM app_settings WHERE key = 'mail_settings'").run();
    const user = freshUser();
    alertPasswordChanged(user.email, false, "203.0.113.5");
    alertMfaEnabled(user.email, "203.0.113.5");
    await flush();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("mails both the old and the new address on an email change", async () => {
    const user = freshUser();
    alertEmailChanged(user.email, "attacker@evil.test", "203.0.113.5");
    await flush();
    expect(recipients()).toEqual([[user.email, "attacker@evil.test"]]);
    expect(bodies()[0]).toContain("attacker@evil.test");
  });

  it("tells the owner whether an admin or they themselves changed the password", async () => {
    const self = freshUser();
    alertPasswordChanged(self.email, false, "203.0.113.5");
    await flush();
    expect(recipients()).toEqual([[self.email]]);
    expect(bodies()[0]).toContain("was changed");

    vi.clearAllMocks();
    const other = freshUser();
    alertPasswordChanged(other.email, true, "203.0.113.5");
    await flush();
    expect(bodies()[0]).toContain("An administrator set a new password");
  });

  it("alerts the owner when two-factor is switched on or backup codes are replaced", async () => {
    const user = freshUser();
    alertMfaEnabled(user.email, "203.0.113.5");
    alertMfaBackupCodesRegenerated(user.email, "203.0.113.5");
    await flush();
    expect(recipients()).toEqual([[user.email], [user.email]]);
  });

  it("throttles a repeat of the same change on the same account", async () => {
    const user = freshUser();
    alertPasswordChanged(user.email, false, "203.0.113.5");
    alertPasswordChanged(user.email, false, "203.0.113.5");
    await flush();
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});

describe("repeated two-factor failure alerts", () => {
  function failMfa(user: User, times: number): void {
    for (let i = 0; i < times; i += 1) {
      logActivity({
        event: "auth.mfa_failed",
        targetType: "user",
        targetId: user.id,
        detail: "A two-factor code was rejected.",
        ipAddress: "203.0.113.9"
      });
    }
  }

  it("counts only recent failures for that account", () => {
    const user = freshUser();
    const other = freshUser();
    failMfa(user, 2);
    failMfa(other, 1);
    expect(recentMfaFailureCount(user.id)).toBe(2);

    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    db.prepare(
      "INSERT INTO activity_logs (id, event, target_type, target_id, detail, created_at) VALUES ('old', 'auth.mfa_failed', 'user', ?, 'x', ?)"
    ).run(user.id, old);
    expect(recentMfaFailureCount(user.id)).toBe(2);
  });

  it("stays quiet below the threshold", async () => {
    const user = freshUser();
    failMfa(user, MFA_FAILURE_ALERT_THRESHOLD - 1);
    alertMfaFailures(user, "203.0.113.9");
    await flush();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("alerts the owner and the admins once the threshold is reached", async () => {
    const admin = freshUser("admin");
    const user = freshUser();
    failMfa(user, MFA_FAILURE_ALERT_THRESHOLD);
    alertMfaFailures(user, "203.0.113.9");
    await flush();
    expect(recipients()).toEqual([[user.email], [admin.email]]);
    expect(bodies()[0]).toContain(`${MFA_FAILURE_ALERT_THRESHOLD} in the last`);
  });

  it("doesn't send an admin a duplicate about their own account", async () => {
    const admin = freshUser("admin");
    failMfa(admin, MFA_FAILURE_ALERT_THRESHOLD);
    alertMfaFailures(admin, "203.0.113.9");
    await flush();
    expect(recipients()).toEqual([[admin.email]]);
  });

  it("alerts once per window, not on every further failure", async () => {
    const user = freshUser();
    failMfa(user, MFA_FAILURE_ALERT_THRESHOLD);
    alertMfaFailures(user, "203.0.113.9");
    failMfa(user, 1);
    alertMfaFailures(user, "203.0.113.9");
    await flush();
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});
