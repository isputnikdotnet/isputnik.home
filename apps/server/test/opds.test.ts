import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import {
  createApiToken,
  generateApiToken,
  listApiTokens,
  resolveApiToken,
  revokeApiToken
} from "../src/core/api-tokens.js";
import {
  buildAcquisitionFeed,
  buildFacetNav,
  buildRootNav,
  type AcquisitionSpec,
  type FacetSpec,
  type LinkCtx
} from "../src/modules/library/ebook/opds.js";
import { resetDb, makeUser, makeLibrary, grant, pastIso } from "./helpers/seed.js";

const ALL_SPEC: AcquisitionSpec = { base: "/all", title: "All ebooks", id: "urn:isputnik:ebooks:all", sort: "title" };
const AUTHOR_SPEC: FacetSpec = { base: "/authors", title: "By author", id: "urn:isputnik:ebooks:authors", facetKey: "authors", param: "author" };
const USER = { id: "u1", role: "member" };
const CTX: LinkCtx = { origin: "http://home.test", tokenInPath: null };

// Seed one ebook (item + metadata + content document + optional author) and return
// the content document id.
function seedEbook(libraryId: string, itemId: string, opts: { title: string; author?: string; cover?: string; language?: string }): string {
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, ?, 'ebook', ?, 'ready')").run(itemId, libraryId, `path/${itemId}`);
  db.prepare("INSERT INTO item_metadata (item_id, source, title, language, cover_storage_key) VALUES (?, 'scan', ?, ?, ?)")
    .run(itemId, opts.title, opts.language ?? null, opts.cover ?? null);
  const docId = `${itemId}-doc`;
  db.prepare("INSERT INTO document_files (id, item_id, role, relative_path, format, mime_type, size, status) VALUES (?, ?, 'content', ?, 'epub', 'application/epub+zip', 1000, 'available')")
    .run(docId, itemId, `${opts.title}.epub`);
  if (opts.author) {
    const pid = `p-${opts.author.replace(/\s+/g, "-")}`;
    db.prepare("INSERT OR IGNORE INTO people (id, name, sort_name) VALUES (?, ?, ?)").run(pid, opts.author, opts.author);
    db.prepare("INSERT INTO item_people (item_id, person_id, role, sort_order) VALUES (?, ?, 'author', 0)").run(itemId, pid);
  }
  return docId;
}

beforeEach(() => {
  resetDb();
  makeUser("u1");
});

describe("api tokens", () => {
  it("mints a prefixed token that resolves to its user", () => {
    const { raw } = createApiToken("u1", "Kobo", "opds");
    expect(raw.startsWith("isp_opds_")).toBe(true);
    const user = resolveApiToken(raw);
    expect(user?.id).toBe("u1");
  });

  it("records last_seen / last_ip on a successful resolve", () => {
    const { raw } = createApiToken("u1", null, "opds");
    resolveApiToken(raw, "opds", "203.0.113.7");
    const row = db.prepare("SELECT last_seen_at, last_ip FROM api_tokens WHERE user_id = 'u1'").get() as { last_seen_at: string | null; last_ip: string | null };
    expect(row.last_seen_at).not.toBeNull();
    expect(row.last_ip).toBe("203.0.113.7");
  });

  it("returns null for revoked, expired, wrong-scope, and garbage tokens", () => {
    const { id, raw } = createApiToken("u1", null, "opds");
    expect(revokeApiToken("u1", id)).toBe(true);
    expect(resolveApiToken(raw)).toBeNull();

    const expired = generateApiToken("opds");
    db.prepare("INSERT INTO api_tokens (id, user_id, token_hash, scope, expires_at) VALUES ('t-exp', 'u1', ?, 'opds', ?)").run(expired.hash, pastIso());
    expect(resolveApiToken(expired.raw)).toBeNull();

    const otherScope = generateApiToken("opds");
    db.prepare("INSERT INTO api_tokens (id, user_id, token_hash, scope) VALUES ('t-scope', 'u1', ?, 'future')").run(otherScope.hash);
    expect(resolveApiToken(otherScope.raw, "opds")).toBeNull();

    expect(resolveApiToken("not-a-token")).toBeNull();
    expect(resolveApiToken("")).toBeNull();
  });

  it("lists only a user's active (non-revoked) tokens", () => {
    createApiToken("u1", "Keep", "opds");
    const { id } = createApiToken("u1", "Drop", "opds");
    makeUser("u2");
    createApiToken("u2", "Other user", "opds");
    revokeApiToken("u1", id);

    const tokens = listApiTokens("u1", "opds");
    expect(tokens).toHaveLength(1);
    expect(tokens[0].label).toBe("Keep");
  });

  it("won't resolve a token for an inactive user", () => {
    const { raw } = createApiToken("u1", null, "opds");
    db.prepare("UPDATE users SET is_active = 0 WHERE id = 'u1'").run();
    expect(resolveApiToken(raw)).toBeNull();
  });
});

describe("OPDS root navigation feed", () => {
  it("lists the browse axes and a search link", () => {
    const xml = buildRootNav(CTX);
    expect(xml).toContain("<title>isputnik ebooks</title>");
    expect(xml).toContain("http://home.test/opds/recent");
    expect(xml).toContain("http://home.test/opds/all");
    expect(xml).toContain("http://home.test/opds/authors");
    expect(xml).toContain('rel="search"');
  });

  it("preserves a path token in every generated link", () => {
    const xml = buildRootNav({ origin: "http://home.test", tokenInPath: "isp_opds_TOK" });
    expect(xml).toContain("http://home.test/opds/isp_opds_TOK/recent");
    expect(xml).not.toContain("http://home.test/opds/recent");
  });
});

describe("OPDS acquisition feed", () => {
  beforeEach(() => {
    makeLibrary("L1", { createdBy: "u1", type: "ebook" });
    makeLibrary("L2", { createdBy: "u1", type: "ebook" });
    grant("group", EVERYONE_GROUP_ID, "L1", "member"); // public => u1 can browse L1
    seedEbook("L1", "e1", { title: "Visible Book", author: "Jane Doe", cover: "covers/ab/cd/e1-cover.webp", language: "en" });
    seedEbook("L2", "e2", { title: "Hidden Book", author: "John Roe" }); // private library, u1 has no grant
  });

  it("includes only books in libraries the user can access", () => {
    const xml = buildAcquisitionFeed(USER, CTX, ALL_SPEC, {});
    expect(xml).toContain("Visible Book");
    expect(xml).not.toContain("Hidden Book");
    expect(xml).toContain("<opensearch:totalResults>1</opensearch:totalResults>");
  });

  it("emits an acquisition link and cover links per entry", () => {
    const xml = buildAcquisitionFeed(USER, CTX, ALL_SPEC, {});
    expect(xml).toContain('rel="http://opds-spec.org/acquisition"');
    expect(xml).toContain('href="http://home.test/opds/document/e1/e1-doc"');
    expect(xml).toContain('type="application/epub+zip"');
    expect(xml).toContain('rel="http://opds-spec.org/image"');
    expect(xml).toContain("http://home.test/opds/cover/covers/ab/cd/e1-cover.webp");
  });

  it("preserves a path token in acquisition + cover + paging links", () => {
    const xml = buildAcquisitionFeed(USER, { origin: "http://home.test", tokenInPath: "isp_opds_TOK" }, ALL_SPEC, {});
    expect(xml).toContain("http://home.test/opds/isp_opds_TOK/document/e1/e1-doc");
    expect(xml).toContain("http://home.test/opds/isp_opds_TOK/cover/");
  });

  it("filters by author query", () => {
    expect(buildAcquisitionFeed(USER, CTX, ALL_SPEC, { author: "Jane Doe" })).toContain("Visible Book");
    expect(buildAcquisitionFeed(USER, CTX, ALL_SPEC, { author: "Nobody" })).not.toContain("Visible Book");
  });
});

describe("OPDS facet navigation feed", () => {
  beforeEach(() => {
    makeLibrary("L1", { createdBy: "u1", type: "ebook" });
    grant("group", EVERYONE_GROUP_ID, "L1", "member");
    seedEbook("L1", "e1", { title: "Visible Book", author: "Jane Doe" });
  });

  it("lists authors, each linking to a filtered acquisition feed", () => {
    const xml = buildFacetNav(USER, CTX, AUTHOR_SPEC);
    expect(xml).toContain("<title>Jane Doe</title>");
    expect(xml).toContain("http://home.test/opds/all?author=Jane+Doe");
  });
});
