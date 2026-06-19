import { beforeEach, describe, expect, it } from "vitest";
import {
  setLibraryAccess,
  canUserAccessLibrary,
  canUserManageLibraryMembers,
  accessibleLibraryIds,
  libraryCapabilities,
  canUserAccessBook
} from "../src/modules/library/shared/library-access.js";
import { resetDb, makeUser, makeLibrary, makeShare } from "./helpers/seed.js";

const lib = (id: string) => ({ id });

beforeEach(resetDb);

describe("setLibraryAccess + canUserAccessLibrary", () => {
  it("public library: Everyone gets access, owner gets manager", () => {
    makeUser("owner");
    makeUser("stranger");
    makeLibrary("L", { createdBy: "owner" });
    setLibraryAccess("L", { visibility: "public", publicRole: "member", ownerType: "user", ownerId: "owner", createdBy: "owner" });

    expect(canUserAccessLibrary(lib("L"), "stranger", "member")).toBe(true);
    expect(canUserManageLibraryMembers(lib("L"), "owner", "member")).toBe(true);
    expect(canUserManageLibraryMembers(lib("L"), "stranger", "member")).toBe(false);
  });

  it("private library: only the owner has access", () => {
    makeUser("owner");
    makeUser("stranger");
    makeLibrary("L", { createdBy: "owner" });
    setLibraryAccess("L", { visibility: "private", ownerType: "user", ownerId: "owner", createdBy: "owner" });

    expect(canUserAccessLibrary(lib("L"), "owner", "member")).toBe(true);
    expect(canUserAccessLibrary(lib("L"), "stranger", "member")).toBe(false);
  });

  it("flipping public -> private removes the Everyone grant", () => {
    makeUser("owner");
    makeUser("stranger");
    makeLibrary("L", { createdBy: "owner" });
    setLibraryAccess("L", { visibility: "public", publicRole: "member", ownerType: "user", ownerId: "owner", createdBy: "owner" });
    expect(canUserAccessLibrary(lib("L"), "stranger", "member")).toBe(true);

    setLibraryAccess("L", { visibility: "private", ownerType: "user", ownerId: "owner", createdBy: "owner" });
    expect(canUserAccessLibrary(lib("L"), "stranger", "member")).toBe(false);
    expect(canUserAccessLibrary(lib("L"), "owner", "member")).toBe(true);
  });

  it("returns false for a library with no id", () => {
    expect(canUserAccessLibrary({ id: undefined }, "anyone", "member")).toBe(false);
  });
});

describe("libraryCapabilities", () => {
  it("public viewer library: view only, no download", () => {
    makeUser("owner");
    makeLibrary("L", { createdBy: "owner" });
    setLibraryAccess("L", { visibility: "public", publicRole: "viewer", ownerType: "user", ownerId: "owner", createdBy: "owner" });

    const caps = libraryCapabilities({ id: "L" }, "stranger", "member");
    expect(caps.role).toBe("viewer");
    expect(caps.canView).toBe(true);
    expect(caps.canDownload).toBe(false);
    expect(caps.canUpload).toBe(false);
  });

  it("external policy disables writes for the manager but keeps reads", () => {
    makeUser("owner");
    makeLibrary("L", { createdBy: "owner", policyJson: '{"mode":"external"}' });
    setLibraryAccess("L", { visibility: "private", ownerType: "user", ownerId: "owner", createdBy: "owner" });

    const caps = libraryCapabilities({ id: "L", policy_json: '{"mode":"external"}' }, "owner", "member");
    expect(caps.canManageLibrary).toBe(true); // manage is not policy-gated
    expect(caps.canView).toBe(true);
    expect(caps.canUpload).toBe(false);
    expect(caps.canDelete).toBe(false);
  });
});

describe("accessibleLibraryIds", () => {
  beforeEach(() => {
    makeUser("owner");
    makeLibrary("pub", { createdBy: "owner", type: "audiobook" });
    makeLibrary("priv", { createdBy: "owner", type: "audiobook" });
    makeLibrary("ebook-pub", { createdBy: "owner", type: "ebook" });
    setLibraryAccess("pub", { visibility: "public", publicRole: "member", createdBy: "owner" });
    setLibraryAccess("priv", { visibility: "private", ownerType: "user", ownerId: "owner", createdBy: "owner" });
    setLibraryAccess("ebook-pub", { visibility: "public", publicRole: "member", createdBy: "owner" });
  });

  it("a stranger sees only the public libraries", () => {
    const ids = accessibleLibraryIds("stranger", "member");
    expect(ids.has("pub")).toBe(true);
    expect(ids.has("ebook-pub")).toBe(true);
    expect(ids.has("priv")).toBe(false);
  });

  it("filters by library type", () => {
    const ids = accessibleLibraryIds("stranger", "member", "ebook");
    expect([...ids]).toEqual(["ebook-pub"]);
  });

  it("an admin sees public libraries (and not the private one without a grant)", () => {
    const ids = accessibleLibraryIds("admin-1", "admin");
    expect(ids.has("pub")).toBe(true);
    expect(ids.has("priv")).toBe(false);
  });
});

describe("canUserAccessBook (book-level share overrides a private library)", () => {
  it("denies a stranger on a private library, then allows after a user share", () => {
    makeUser("owner");
    makeUser("friend");
    makeLibrary("L", { createdBy: "owner" });
    setLibraryAccess("L", { visibility: "private", ownerType: "user", ownerId: "owner", createdBy: "owner" });

    expect(canUserAccessBook("book-1", lib("L"), "friend", "member", "audiobook")).toBe(false);

    makeShare({ module: "audiobook", resourceId: "book-1", userId: "friend", createdBy: "owner" });
    expect(canUserAccessBook("book-1", lib("L"), "friend", "member", "audiobook")).toBe(true);
  });

  it("honours an ebook share and keeps modules isolated", () => {
    makeUser("owner");
    makeUser("friend");
    makeLibrary("L", { createdBy: "owner" });
    setLibraryAccess("L", { visibility: "private", ownerType: "user", ownerId: "owner", createdBy: "owner" });

    makeShare({ module: "ebook", resourceId: "doc-1", userId: "friend", createdBy: "owner" });
    expect(canUserAccessBook("doc-1", lib("L"), "friend", "member", "ebook")).toBe(true);
    // The same share must not leak across the module boundary.
    expect(canUserAccessBook("doc-1", lib("L"), "friend", "member", "audiobook")).toBe(false);
  });
});
