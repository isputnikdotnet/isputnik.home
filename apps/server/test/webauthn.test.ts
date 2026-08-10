import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { config } from "../src/config.js";
import {
  passkeysAvailable,
  rpId,
  rpOrigin,
  createWebauthnChallenge,
  resolveWebauthnChallenge,
  clearWebauthnChallenge,
  pruneWebauthnChallenges,
  listPasskeys,
  countPasskeys,
  findPasskeyByCredentialId,
  insertPasskey,
  deletePasskey,
  clearPasskeys,
  touchPasskey,
  counterLooksCloned,
  parseTransports,
  type VerifiedRegistration
} from "../src/core/webauthn.js";
import { resetDb, makeUser } from "./helpers/seed.js";

const realAppUrl = config.appUrl;

beforeEach(() => {
  resetDb();
  makeUser("u1");
  makeUser("u2");
});

afterEach(() => {
  config.appUrl = realAppUrl;
});

function credential(overrides: Partial<VerifiedRegistration> = {}): VerifiedRegistration {
  return {
    credentialId: "cred-aaa",
    publicKey: "cHVibGljLWtleQ",
    counter: 0,
    transports: JSON.stringify(["internal"]),
    backedUp: true,
    ...overrides
  };
}

describe("relying party derivation", () => {
  it("takes the RP ID from APP_URL's hostname and the origin verbatim", () => {
    config.appUrl = "https://library.example.com";
    expect(rpId()).toBe("library.example.com");
    expect(rpOrigin()).toBe("https://library.example.com");
  });

  it("keeps the port in the origin but never in the RP ID", () => {
    // A passkey is bound to the bare host; the origin check is what cares about port.
    config.appUrl = "https://library.example.com:8443";
    expect(rpId()).toBe("library.example.com");
    expect(rpOrigin()).toBe("https://library.example.com:8443");
  });
});

describe("availability gate", () => {
  it("offers passkeys over HTTPS at a domain", () => {
    config.appUrl = "https://library.example.com";
    expect(passkeysAvailable()).toBe(true);
  });

  it("refuses a plain-http LAN install — the default deployment", () => {
    // WebAuthn simply doesn't exist outside a secure context, so offering a button
    // here could only ever fail.
    config.appUrl = "http://192.168.1.50:4000";
    expect(passkeysAvailable()).toBe(false);
  });

  it("refuses an IP address even over HTTPS", () => {
    // An IP literal is not a registrable domain, so it cannot be an RP ID — a cert
    // doesn't rescue it.
    config.appUrl = "https://192.168.1.50";
    expect(passkeysAvailable()).toBe(false);
  });

  it("refuses a bare hostname with no dot", () => {
    config.appUrl = "https://nas";
    expect(passkeysAvailable()).toBe(false);
  });

  it("allows localhost, which browsers treat as secure — this is the dev server", () => {
    config.appUrl = "http://localhost:5173";
    expect(passkeysAvailable()).toBe(true);
  });

  it("refuses 127.0.0.1 even though it is a secure context", () => {
    // Verified against a real browser: rp.id "127.0.0.1" throws SecurityError
    // ("not a registrable domain suffix of, nor equal to, the current domain").
    // Secure context is necessary but not sufficient — the RP ID needs a NAME.
    config.appUrl = "http://127.0.0.1:5173";
    expect(passkeysAvailable()).toBe(false);
  });

  it("refuses an unparseable APP_URL rather than guessing", () => {
    config.appUrl = "not a url";
    expect(passkeysAvailable()).toBe(false);
  });
});

describe("challenges", () => {
  it("round-trips a challenge and forgets it when cleared", () => {
    const id = createWebauthnChallenge("chal-1", "register", "u1");
    expect(resolveWebauthnChallenge(id, "register")?.challenge).toBe("chal-1");
    clearWebauthnChallenge(id);
    expect(resolveWebauthnChallenge(id, "register")).toBeNull();
  });

  it("won't resolve under the wrong purpose", () => {
    // A registration challenge must not be redeemable as a sign-in.
    const id = createWebauthnChallenge("chal-1", "register", "u1");
    expect(resolveWebauthnChallenge(id, "login")).toBeNull();
  });

  it("opens a sign-in challenge with no user — the account isn't known yet", () => {
    const id = createWebauthnChallenge("chal-1", "login", null);
    expect(resolveWebauthnChallenge(id, "login")?.user_id).toBeNull();
  });

  it("supersedes an abandoned ceremony for the same user and purpose", () => {
    const first = createWebauthnChallenge("chal-1", "register", "u1");
    const second = createWebauthnChallenge("chal-2", "register", "u1");
    expect(resolveWebauthnChallenge(first, "register")).toBeNull();
    expect(resolveWebauthnChallenge(second, "register")?.challenge).toBe("chal-2");
  });

  it("doesn't resolve an expired challenge, and prunes it", () => {
    const id = createWebauthnChallenge("chal-1", "login", null);
    db.prepare("UPDATE webauthn_challenges SET expires_at = datetime('now', '-1 minute') WHERE id = ?").run(id);
    expect(resolveWebauthnChallenge(id, "login")).toBeNull();

    pruneWebauthnChallenges();
    expect(db.prepare("SELECT COUNT(*) AS n FROM webauthn_challenges").get()).toEqual({ n: 0 });
  });

  it("leaves live challenges alone when pruning", () => {
    const id = createWebauthnChallenge("chal-live", "login", null);
    pruneWebauthnChallenges();
    expect(resolveWebauthnChallenge(id, "login")).not.toBeNull();
  });
});

describe("stored credentials", () => {
  it("stores and finds a passkey by its credential id", () => {
    insertPasskey("u1", "iPhone", credential());
    const found = findPasskeyByCredentialId("cred-aaa");
    expect(found?.user_id).toBe("u1");
    expect(found?.label).toBe("iPhone");
    expect(found?.backed_up).toBe(1);
  });

  it("counts and lists only the owner's passkeys", () => {
    insertPasskey("u1", "one", credential({ credentialId: "cred-1" }));
    insertPasskey("u1", "two", credential({ credentialId: "cred-2" }));
    insertPasskey("u2", "other", credential({ credentialId: "cred-3" }));

    expect(countPasskeys("u1")).toBe(2);
    expect(listPasskeys("u1").map((row) => row.label).sort()).toEqual(["one", "two"]);
    expect(countPasskeys("u2")).toBe(1);
  });

  it("refuses to delete someone else's passkey", () => {
    const id = insertPasskey("u1", "mine", credential());
    expect(deletePasskey("u2", id)).toBe(false);
    expect(countPasskeys("u1")).toBe(1);
    expect(deletePasskey("u1", id)).toBe(true);
    expect(countPasskeys("u1")).toBe(0);
  });

  it("clears every passkey on one account and no others — the admin rescue", () => {
    insertPasskey("u1", "a", credential({ credentialId: "cred-1" }));
    insertPasskey("u1", "b", credential({ credentialId: "cred-2" }));
    insertPasskey("u2", "c", credential({ credentialId: "cred-3" }));

    expect(clearPasskeys("u1")).toBe(2);
    expect(countPasskeys("u1")).toBe(0);
    expect(countPasskeys("u2")).toBe(1);
  });

  it("goes with the user when the account is deleted", () => {
    insertPasskey("u1", "gone", credential());
    db.prepare("DELETE FROM users WHERE id = 'u1'").run();
    expect(findPasskeyByCredentialId("cred-aaa")).toBeNull();
  });

  it("won't register the same credential twice", () => {
    insertPasskey("u1", "first", credential());
    expect(() => insertPasskey("u2", "second", credential())).toThrow();
  });
});

describe("use counter", () => {
  it("records when and where a passkey was last used", () => {
    insertPasskey("u1", "iPhone", credential({ counter: 3 }));
    touchPasskey("cred-aaa", 4, "203.0.113.9");

    const row = findPasskeyByCredentialId("cred-aaa")!;
    expect(row.counter).toBe(4);
    expect(row.last_ip).toBe("203.0.113.9");
    expect(row.last_used_at).not.toBeNull();
  });

  it("keeps the highest counter it has seen", () => {
    // A synced passkey reports 0 forever; that must not walk a real counter back.
    insertPasskey("u1", "iPhone", credential({ counter: 7 }));
    touchPasskey("cred-aaa", 0, null);
    expect(findPasskeyByCredentialId("cred-aaa")!.counter).toBe(7);
  });

  it("only calls a counter suspicious when it goes backwards from a real value", () => {
    expect(counterLooksCloned(5, 6)).toBe(false); // advanced — normal
    expect(counterLooksCloned(5, 5)).toBe(true); // stalled on a counting authenticator
    expect(counterLooksCloned(5, 3)).toBe(true); // went backwards
    // Zeroes mean "this authenticator doesn't count", which is the normal case for
    // every synced passkey and evidence of nothing.
    expect(counterLooksCloned(0, 0)).toBe(false);
    expect(counterLooksCloned(0, 5)).toBe(false);
    expect(counterLooksCloned(5, 0)).toBe(false);
  });
});

describe("transports", () => {
  it("reads back what was stored, and shrugs off anything else", () => {
    expect(parseTransports(JSON.stringify(["internal", "hybrid"]))).toEqual(["internal", "hybrid"]);
    expect(parseTransports(null)).toBeUndefined();
    expect(parseTransports("not json")).toBeUndefined();
    expect(parseTransports('{"not":"an array"}')).toBeUndefined();
  });
});
