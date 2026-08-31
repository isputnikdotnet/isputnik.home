// Life facts on a contributor — born, died, country, occupation. Two things are
// worth pinning: the dates that reach the database are always partial ISO
// ("YYYY" | "YYYY-MM" | "YYYY-MM-DD") no matter how a source spelled them, and
// merging two people carries the facts across. The merge hand-copies every
// column when the target row doesn't exist yet, so a field forgotten there is a
// field the merge silently drops.
import { beforeEach, describe, expect, it } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { audiobookPeoplePlugin } from "../src/modules/library/audiobook/people.js";
import { looksLikeContributor, normalizePartialDate, trimYearRange } from "../src/modules/library/audiobook/enrich.js";
import { partialDateSchema } from "../src/modules/familytree/persons.js";
import { resetDb, makeUser, grant } from "./helpers/seed.js";

let app: FastifyInstance;

function saveProfile(user: string, name: string, body: Record<string, unknown>) {
  return app.inject({
    method: "PATCH",
    url: `/api/library/people/by-name?name=${encodeURIComponent(name)}`,
    headers: { "x-test-user": user, "content-type": "application/json" },
    payload: JSON.stringify(body)
  });
}

function readProfile(user: string, name: string) {
  return app.inject({
    method: "GET",
    url: `/api/library/people/by-name?name=${encodeURIComponent(name)}`,
    headers: { "x-test-user": user }
  });
}

beforeEach(async () => {
  resetDb();
  makeUser("writer");
  makeUser("admin", "admin");
  db.prepare(
    "INSERT INTO libraries (id, name, type, source_path, created_by, policy_json) VALUES ('AUD', 'AUD', 'audiobook', '/src', 'writer', '{}')"
  ).run();
  grant("user", "writer", "AUD", "contributor");
  db.prepare("INSERT INTO people (id, name, sort_name) VALUES ('p1', 'Jane Author', 'Author, Jane')").run();

  app = fastify();
  app.decorate("authenticate", async (request, reply) => {
    const id = request.headers["x-test-user"] as string | undefined;
    const row = id ? (db.prepare("SELECT id, role FROM users WHERE id = ?").get(id) as { id: string; role: string } | undefined) : undefined;
    if (!row) { reply.code(401).send({ error: "no" }); return; }
    request.user = row as never;
  });
  app.decorate("requireAdmin", async (request, reply) => {
    const id = request.headers["x-test-user"] as string | undefined;
    const row = id ? (db.prepare("SELECT id, role FROM users WHERE id = ?").get(id) as { id: string; role: string } | undefined) : undefined;
    if (!row || row.role !== "admin") { reply.code(403).send({ error: "no" }); return; }
    request.user = row as never;
  });
  await app.register(audiobookPeoplePlugin);
  await app.ready();
});

describe("normalizePartialDate", () => {
  it("keeps values that are already partial ISO dates", () => {
    expect(normalizePartialDate("1899")).toBe("1899");
    expect(normalizePartialDate("1899-07")).toBe("1899-07");
    expect(normalizePartialDate("1899-07-21")).toBe("1899-07-21");
  });

  it("reads the prose shapes Open Library and Wikipedia actually return", () => {
    expect(normalizePartialDate("2 September 1952")).toBe("1952-09-02");
    expect(normalizePartialDate("September 2, 1952")).toBe("1952-09-02");
    expect(normalizePartialDate("Sep. 2, 1952")).toBe("1952-09-02");
    expect(normalizePartialDate("March 1899")).toBe("1899-03");
  });

  it("falls back to the year when that is all the value can be read as", () => {
    expect(normalizePartialDate("c. 1849")).toBe("1849");
    expect(normalizePartialDate("1899?")).toBe("1899");
    expect(normalizePartialDate("born 1920 in Illinois")).toBe("1920");
  });

  it("drops a part that isn't a real calendar date rather than storing it", () => {
    // 31 September doesn't exist; the month still does.
    expect(normalizePartialDate("1952-09-31")).toBe("1952-09");
    expect(normalizePartialDate("1952-13-02")).toBe("1952");
  });

  it("gives nothing rather than something wrong", () => {
    expect(normalizePartialDate(null)).toBeNull();
    expect(normalizePartialDate("")).toBeNull();
    expect(normalizePartialDate("unknown")).toBeNull();
    // BCE has no expression in the YYYY convention.
    expect(normalizePartialDate("384 BC")).toBeNull();
  });

  it("only ever produces values the profile route will accept", () => {
    const samples = ["1899", "1899-07", "2 September 1952", "c. 1849", "1952-09-31", "March 1899"];
    for (const sample of samples) {
      const value = normalizePartialDate(sample);
      expect(value, sample).not.toBeNull();
      expect(partialDateSchema.safeParse(value).success, `${sample} → ${value}`).toBe(true);
    }
  });
});

describe("trimYearRange", () => {
  it("drops the year range Wikipedia repeats in its short description", () => {
    // Measured on the real page: the years land in Born/Died anyway, and the
    // page would otherwise read "English novelist (1775–1817) · 1775 – 1817".
    expect(trimYearRange("English novelist (1775-1817)")).toBe("English novelist");
    expect(trimYearRange("Russian writer (1828–1910)")).toBe("Russian writer");
    expect(trimYearRange("American author (b. 1952)")).toBe("American author");
    // Real narrator pages — both end with the years already shown beside them.
    expect(trimYearRange("American actor, narrator, writer, and film director (born 1970)"))
      .toBe("American actor, narrator, writer, and film director");
    expect(trimYearRange("British actor, singer, songwriter (born 1935)"))
      .toBe("British actor, singer, songwriter");
  });

  it("leaves a parenthetical that says something", () => {
    expect(trimYearRange("English writer and humorist")).toBe("English writer and humorist");
    expect(trimYearRange("novelist (pen name of Eric Blair)")).toBe("novelist (pen name of Eric Blair)");
    expect(trimYearRange("1816 novel by Jane Austen")).toBe("1816 novel by Jane Austen");
    // An empty parenthetical says nothing, but there is no date in it either.
    expect(trimYearRange("translator ()")).toBe("translator ()");
  });

  // This used to decide "is the parenthetical only dates?" with one repeated
  // alternation of overlapping fragments (born|…|BCE?|…|[bcdr]), which
  // backtracks exponentially when the closing ")" never comes: a 49-character
  // "(bcbcbc…" took 111ms, 57 characters took minutes, and Node has one thread
  // to wedge. The description is a Wikipedia page's, and anyone can edit those.
  it("cannot be wedged by a parenthetical that never closes", () => {
    const attack = `(${"bc".repeat(100_000)}`;

    const started = Date.now();
    expect(trimYearRange(attack)).toBe(attack);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("looksLikeContributor", () => {
  // Real en.wikipedia short descriptions, fetched from the live pages. The
  // automatic lookup drops any English page this rejects, so a narrator missing
  // from this list is a narrator the scanner silently skips.
  it("accepts the pages narrators actually have", () => {
    for (const description of [
      "British audiobook narrator",                        // Simon Vance
      "American audiobook narrator and actor",             // Scott Brick
      "American actress and audiobook narrator",           // Kate Reading
      "British actor, singer, songwriter (born 1935)",     // Jim Dale
      "American actor (born 1962)",                        // Bahni Turpin
      "American actor, narrator, writer, and film director (born 1970)" // Edoardo Ballerini
    ]) {
      expect(looksLikeContributor(description), description).toBe(true);
    }
  });

  it("still accepts the pages authors have", () => {
    for (const description of [
      "English novelist",                                  // Jane Austen
      "English writer and humorist",                       // Douglas Adams
      "American writer and journalist"
    ]) {
      expect(looksLikeContributor(description), description).toBe(true);
    }
  });

  it("still rejects a same-name stranger", () => {
    // The Joe Barrett en.wikipedia has is a hurler, not the narrator credited
    // in the library — exactly what this guard exists to keep out.
    expect(looksLikeContributor("Irish sportsperson")).toBe(false);
    expect(looksLikeContributor("association football player")).toBe(false);
    expect(looksLikeContributor("1816 novel by Jane Austen")).toBe(false);
  });
});

describe("the profile route stores and returns life facts", () => {
  it("round-trips born, died, country and occupation", async () => {
    const saved = await saveProfile("writer", "Jane Author", {
      birthDate: "1899-07-21",
      deathDate: "1961",
      country: "United States",
      occupation: "Novelist and journalist"
    });
    expect(saved.statusCode).toBe(200);

    const read = await readProfile("writer", "Jane Author");
    expect(read.statusCode).toBe(200);
    expect(read.json().person).toMatchObject({
      birthDate: "1899-07-21",
      deathDate: "1961",
      country: "United States",
      occupation: "Novelist and journalist"
    });
  });

  it("rejects a date that isn't on the partial-date convention", async () => {
    const res = await saveProfile("writer", "Jane Author", { birthDate: "21 July 1899" });
    expect(res.statusCode).toBe(400);
    const row = db.prepare("SELECT birth_date FROM people WHERE id = 'p1'").get() as { birth_date: string | null };
    expect(row.birth_date).toBeNull();
  });
});

describe("merging carries the facts to the surviving person", () => {
  it("copies every fact column when the target person is new", async () => {
    await saveProfile("writer", "Jane Author", {
      birthDate: "1899-07-21",
      deathDate: "1961",
      country: "United States",
      occupation: "Novelist"
    });
    db.prepare("UPDATE people SET wikipedia_url = 'https://en.wikipedia.org/wiki/Jane' WHERE id = 'p1'").run();

    const res = await app.inject({
      method: "POST",
      url: "/api/library/people/merge",
      headers: { "x-test-user": "admin", "content-type": "application/json" },
      payload: JSON.stringify({ from: "Jane Author", into: "J. Author" })
    });
    expect(res.statusCode).toBe(200);

    const row = db.prepare(
      "SELECT birth_date, death_date, country, occupation, wikipedia_url FROM people WHERE name = 'J. Author'"
    ).get() as Record<string, string | null>;
    expect(row).toMatchObject({
      birth_date: "1899-07-21",
      death_date: "1961",
      country: "United States",
      occupation: "Novelist",
      wikipedia_url: "https://en.wikipedia.org/wiki/Jane"
    });
  });
});
