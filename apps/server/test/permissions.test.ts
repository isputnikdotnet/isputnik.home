import { beforeEach, describe, expect, it } from "vitest";
import {
  roleAllows,
  parsePolicy,
  resolveObjectRole,
  can,
  getEveryoneRole,
  EVERYONE_GROUP_ID,
  type AuthUser
} from "../src/core/permissions.js";
import { resetDb, makeUser, makeGroup, addToGroup, grant } from "./helpers/seed.js";

const member = (id: string): AuthUser => ({ id, role: "member" });
const admin = (id: string): AuthUser => ({ id, role: "admin" });
const LIB = "lib-1";

beforeEach(resetDb);

describe("roleAllows (pure role/action matrix)", () => {
  it("denies everything when the user has no role", () => {
    for (const action of ["view", "download", "upload", "edit", "delete", "manage"] as const) {
      expect(roleAllows(null, action)).toBe(false);
    }
  });

  it("viewer may only view", () => {
    expect(roleAllows("viewer", "view")).toBe(true);
    expect(roleAllows("viewer", "download")).toBe(false);
    expect(roleAllows("viewer", "manage")).toBe(false);
  });

  it("member adds download but not writes", () => {
    expect(roleAllows("member", "download")).toBe(true);
    expect(roleAllows("member", "upload")).toBe(false);
    expect(roleAllows("member", "edit")).toBe(false);
  });

  it("contributor may upload and edit but not delete or manage", () => {
    expect(roleAllows("contributor", "upload")).toBe(true);
    expect(roleAllows("contributor", "edit")).toBe(true);
    expect(roleAllows("contributor", "delete")).toBe(false);
    expect(roleAllows("contributor", "manage")).toBe(false);
  });

  it("manager may do everything", () => {
    for (const action of ["view", "download", "upload", "edit", "delete", "manage"] as const) {
      expect(roleAllows("manager", action)).toBe(true);
    }
  });
});

describe("parsePolicy", () => {
  it("returns an empty policy for null/empty/invalid JSON", () => {
    expect(parsePolicy(null)).toEqual({});
    expect(parsePolicy(undefined)).toEqual({});
    expect(parsePolicy("")).toEqual({});
    expect(parsePolicy("{not json")).toEqual({});
  });

  it("parses a valid policy blob", () => {
    expect(parsePolicy('{"mode":"external","allowUpload":false}')).toEqual({
      mode: "external",
      allowUpload: false
    });
  });
});

describe("resolveObjectRole (assignments engine)", () => {
  it("returns null when there is no grant (private object)", () => {
    makeUser("u1");
    expect(resolveObjectRole("library", LIB, member("u1"))).toBeNull();
  });

  it("grants the Everyone role to any signed-in user", () => {
    makeUser("u1");
    grant("group", EVERYONE_GROUP_ID, LIB, "viewer");
    expect(resolveObjectRole("library", LIB, member("u1"))).toBe("viewer");
  });

  it("lets an explicit user grant override the Everyone baseline", () => {
    makeUser("u1");
    grant("group", EVERYONE_GROUP_ID, LIB, "viewer");
    grant("user", "u1", LIB, "contributor");
    expect(resolveObjectRole("library", LIB, member("u1"))).toBe("contributor");
  });

  it("takes the strongest of multiple grants (user vs group)", () => {
    makeUser("u1");
    const g = makeGroup("grp-1", "u1");
    addToGroup(g, "u1");
    grant("user", "u1", LIB, "member");
    grant("group", g, LIB, "manager");
    expect(resolveObjectRole("library", LIB, member("u1"))).toBe("manager");
  });

  it("resolves a role granted via group membership", () => {
    makeUser("u1");
    const g = makeGroup("grp-1", "u1");
    addToGroup(g, "u1");
    grant("group", g, LIB, "contributor");
    expect(resolveObjectRole("library", LIB, member("u1"))).toBe("contributor");
  });

  it("blocks outright on an explicit user deny, even with an Everyone grant", () => {
    makeUser("u1");
    grant("group", EVERYONE_GROUP_ID, LIB, "member");
    grant("user", "u1", LIB, "deny");
    expect(resolveObjectRole("library", LIB, member("u1"))).toBeNull();
  });

  it("blocks on a deny inherited from a group", () => {
    makeUser("u1");
    const g = makeGroup("grp-1", "u1");
    addToGroup(g, "u1");
    grant("group", EVERYONE_GROUP_ID, LIB, "member");
    grant("group", g, LIB, "deny");
    expect(resolveObjectRole("library", LIB, member("u1"))).toBeNull();
  });

  describe("server admin", () => {
    it("acts as manager on a public object", () => {
      makeUser("a1", "admin");
      grant("group", EVERYONE_GROUP_ID, LIB, "viewer");
      expect(resolveObjectRole("library", LIB, admin("a1"))).toBe("manager");
    });

    it("acts as manager on an object it has an explicit grant on", () => {
      makeUser("a1", "admin");
      grant("user", "a1", LIB, "viewer");
      expect(resolveObjectRole("library", LIB, admin("a1"))).toBe("manager");
    });

    it("is locked out of a private object it has no grant on", () => {
      makeUser("a1", "admin");
      expect(resolveObjectRole("library", LIB, admin("a1"))).toBeNull();
    });

    it("ignores a deny (deny does not apply to admins)", () => {
      makeUser("a1", "admin");
      grant("group", EVERYONE_GROUP_ID, LIB, "member");
      grant("user", "a1", LIB, "deny");
      expect(resolveObjectRole("library", LIB, admin("a1"))).toBe("manager");
    });

    it("stays locked out when its only grant is a lone deny", () => {
      makeUser("a1", "admin");
      grant("user", "a1", LIB, "deny");
      expect(resolveObjectRole("library", LIB, admin("a1"))).toBeNull();
    });
  });
});

describe("can (role + policy combined)", () => {
  it("allows an action the role permits on a managed library", () => {
    makeUser("u1");
    grant("user", "u1", LIB, "manager");
    expect(can(member("u1"), { objectType: "library", objectId: LIB }, "upload")).toBe(true);
  });

  it("refuses writes on an external (read-only) library regardless of role", () => {
    makeUser("u1");
    grant("user", "u1", LIB, "manager");
    const obj = { objectType: "library", objectId: LIB, policy: { mode: "external" as const } };
    expect(can(member("u1"), obj, "upload")).toBe(false);
    expect(can(member("u1"), obj, "delete")).toBe(false);
  });

  it("never lets policy block reads", () => {
    makeUser("u1");
    grant("user", "u1", LIB, "viewer");
    expect(can(member("u1"), { objectType: "library", objectId: LIB, policy: { mode: "external" } }, "view")).toBe(true);
  });

  it("honours per-action write gates without affecting edit", () => {
    makeUser("u1");
    grant("user", "u1", LIB, "manager");
    const policy = { allowUpload: false, allowDelete: false };
    expect(can(member("u1"), { objectType: "library", objectId: LIB, policy }, "upload")).toBe(false);
    expect(can(member("u1"), { objectType: "library", objectId: LIB, policy }, "delete")).toBe(false);
    expect(can(member("u1"), { objectType: "library", objectId: LIB, policy }, "edit")).toBe(true);
  });

  it("refuses any action when the user has no role", () => {
    makeUser("u1");
    expect(can(member("u1"), { objectType: "library", objectId: LIB }, "view")).toBe(false);
  });
});

describe("getEveryoneRole", () => {
  it("returns the Everyone grant's role", () => {
    grant("group", EVERYONE_GROUP_ID, LIB, "member");
    expect(getEveryoneRole("library", LIB)).toBe("member");
  });

  it("returns null when the object is private", () => {
    expect(getEveryoneRole("library", LIB)).toBeNull();
  });

  it("ignores an Everyone deny row", () => {
    grant("group", EVERYONE_GROUP_ID, LIB, "deny");
    expect(getEveryoneRole("library", LIB)).toBeNull();
  });
});
