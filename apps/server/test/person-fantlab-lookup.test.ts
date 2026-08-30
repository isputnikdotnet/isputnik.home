// FantLab as a person source. Wikipedia and Open Library between them know
// almost nothing about the authors a Russian shelf is full of, and nothing at
// all about its narrators, so the "Find info" picker asks FantLab too.
//
// Writers and narrators are separate entities there — different search, record,
// and page ("autor" vs "dictor") — which is the thing these pin, along with the
// two quirks of its API: a birthday with no year ("0000-09-06"), and searches
// fuzzy enough to answer "Толстой" with every Tolstoy.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookupPersonByUrl, lookupPersonCandidates } from "../src/modules/library/audiobook/enrich.js";

const LEM = {
  id: 9,
  name: "Станислав Лем",
  name_orig: "Stanisław Lem",
  anons: "<p>Польский писатель-фантаст.</p>",
  birthday: "1921-09-12",
  deathday: "2006-03-27",
  country_name: "Польша",
  image: "/images/autors/9"
};

// Known day, unknown year — a birthday, not a birth date.
const KAMENISTY = {
  id: 1073,
  name: "Артём Каменистый",
  name_orig: "",
  anons: "Настоящее имя — Артур Смирнов.",
  birthday: "0000-09-06",
  deathday: null,
  country_name: "Украина",
  image: "/images/autors/1073"
};

// A narrator record: the country arrives as a list, not a single name.
const KORSHUNOV = {
  id: 2061,
  name: "Геннадий Коршунов",
  name_orig: "",
  anons: "Геннадий о себе: место рождения г. Москва.",
  birthday: "1983-07-16",
  deathday: null,
  countries: [{ country_id: 1, name: "Россия" }],
  image: "/images/dictors/2061"
};

// Stands in for FantLab's four endpoints: the writer search, the everyone-else
// search, and the two record endpoints. Anything else 404s, as a name only one
// of the two indexes knows would.
function stubFantlab(options: {
  authors?: unknown[];
  persons?: unknown[];
  autorRecords?: Record<string, unknown>;
  dictorRecords?: Record<string, unknown>;
} = {}) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), {
      status: 200, headers: { "content-type": "application/json" }
    });
    if (url.includes("/search-autors")) return json({ matches: options.authors ?? [] });
    if (url.includes("/search-persons")) return json({ matches: options.persons ?? [] });
    const record = url.match(/\/(autor|dictor)\/(\d+)/);
    if (record) {
      const store = record[1] === "autor" ? options.autorRecords : options.dictorRecords;
      if (store?.[record[2]]) return json(store[record[2]]);
    }
    return new Response("nope", { status: 404 });
  }));
}

beforeEach(() => {
  stubFantlab({
    authors: [{ autor_id: 9, rusname: "Станислав Лем" }],
    autorRecords: { 9: LEM, 1073: KAMENISTY }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FantLab person candidates", () => {
  it("maps a writer record onto a profile", async () => {
    const [found] = await lookupPersonCandidates("Станислав Лем", ["ru"], "fantlab");

    expect(found.title).toBe("Станислав Лем");
    expect(found.source).toBe("fantlab");
    expect(found.sourceUrl).toBe("https://fantlab.ru/autor9");
    // The Latin spelling is what tells two same-name results apart.
    expect(found.description).toBe("Stanisław Lem");
    // The blurb arrives as HTML.
    expect(found.bio).toBe("Польский писатель-фантаст.");
    expect(found.photoUrl).toBe("https://fantlab.ru/images/autors/9");
    expect(found.facts.birthDate).toBe("1921-09-12");
    expect(found.facts.deathDate).toBe("2006-03-27");
    expect(found.facts.country).toBe("Польша");
  });

  it("finds a narrator, who is a different kind of record entirely", async () => {
    stubFantlab({
      persons: [{ person_id: 2061, name: "Геннадий Коршунов", type: "dictor" }],
      dictorRecords: { 2061: KORSHUNOV }
    });

    const [found] = await lookupPersonCandidates("Геннадий Коршунов", ["ru"], "fantlab");

    expect(found.sourceUrl).toBe("https://fantlab.ru/dictor2061");
    expect(found.photoUrl).toBe("https://fantlab.ru/images/dictors/2061");
    expect(found.facts.birthDate).toBe("1983-07-16");
    // Listed rather than named on a narrator record.
    expect(found.facts.country).toBe("Россия");
  });

  it("ignores the translators and cover artists that share the narrator index", async () => {
    stubFantlab({
      persons: [
        { person_id: 8986, name: "Геннадий Коршунов", type: "translator" },
        { person_id: 346, name: "Геннадий Коршунов", type: "art" },
        { person_id: 2061, name: "Геннадий Коршунов", type: "dictor" }
      ],
      dictorRecords: { 2061: KORSHUNOV, 8986: KORSHUNOV, 346: KORSHUNOV }
    });

    const found = await lookupPersonCandidates("Геннадий Коршунов", ["ru"], "fantlab");

    expect(found.map((entry) => entry.sourceUrl)).toEqual(["https://fantlab.ru/dictor2061"]);
  });

  it("drops a birthday that carries no year", async () => {
    stubFantlab({
      authors: [{ autor_id: 1073, rusname: "Артём Каменистый" }],
      autorRecords: { 1073: KAMENISTY }
    });

    const [found] = await lookupPersonCandidates("Артём Каменистый", ["ru"], "fantlab");

    expect(found.facts.birthDate).toBeNull();
    expect(found.facts.deathDate).toBeNull();
    expect(found.facts.country).toBe("Украина");
  });

  it("keeps only the people actually named what was asked for", async () => {
    stubFantlab({
      authors: [
        { autor_id: 9, rusname: "Станислав Лем" },
        { autor_id: 1073, rusname: "Артём Каменистый" }
      ],
      persons: [{ person_id: 2061, name: "Геннадий Коршунов", type: "dictor" }],
      autorRecords: { 9: LEM, 1073: KAMENISTY },
      dictorRecords: { 2061: KORSHUNOV }
    });

    const found = await lookupPersonCandidates("Станислав Лем", ["ru"], "fantlab");

    expect(found.map((entry) => entry.title)).toEqual(["Станислав Лем"]);
  });

  it("reads a person straight from a pasted fantlab.ru link, either kind", async () => {
    stubFantlab({ autorRecords: { 9: LEM }, dictorRecords: { 2061: KORSHUNOV } });

    const author = await lookupPersonByUrl("https://fantlab.ru/autor9");
    expect(author?.facts.birthDate).toBe("1921-09-12");

    const narrator = await lookupPersonByUrl("https://fantlab.ru/dictor2061");
    expect(narrator?.sourceUrl).toBe("https://fantlab.ru/dictor2061");
  });

  it("refuses a fantlab.ru link that isn't a person page", async () => {
    await expect(lookupPersonByUrl("https://fantlab.ru/work123")).rejects.toThrow(/FantLab person link/);
  });
});
