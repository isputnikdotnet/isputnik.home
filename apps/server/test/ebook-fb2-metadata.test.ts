import { describe, expect, it } from "vitest";
import { parseFb2Metadata } from "../src/modules/library/ebook/scanner.js";

// Encode an ASCII + Cyrillic string to windows-1251 bytes. Cyrillic А(0x0410)..я(0x044F)
// maps contiguously onto 0xC0..0xFF in cp1251; Ё/ё are the two special cases. Lets us
// build a realistic legacy-Russian FB2 without an encoder dependency.
function win1251(text: string): Buffer {
  return Buffer.from([...text].map((ch) => {
    const c = ch.charCodeAt(0);
    if (c < 0x80) return c;
    if (c >= 0x0410 && c <= 0x044f) return c - 0x0410 + 0xc0;
    if (c === 0x0401) return 0xa8;
    if (c === 0x0451) return 0xb8;
    throw new Error(`win1251: unmapped char ${ch}`);
  }));
}

const utf8Fb2 = `<?xml version="1.0" encoding="UTF-8"?>
<FictionBook xmlns:l="http://www.w3.org/1999/xlink"><description><title-info>
<genre>sf_action</genre>
<author><first-name>Дмитрий</first-name><last-name>Круз</last-name><id>x</id></author>
<author><first-name>Андрей</first-name><last-name>Круз</last-name></author>
<book-title>Ар-Деко</book-title>
<annotation><p>Краткое описание.</p></annotation>
<keywords>боевик, фантастика</keywords>
<date value="2009-05-01">2009</date>
<lang>ru</lang>
<coverpage><image l:href="#cover.jpg"/></coverpage>
</title-info></description>
<binary id="cover.jpg" content-type="image/jpeg">${Buffer.from("JPEGDATA").toString("base64")}</binary>
</FictionBook>`;

describe("parseFb2Metadata", () => {
  it("extracts title, authors, language, subjects, year and cover from a UTF-8 FB2", () => {
    const meta = parseFb2Metadata(Buffer.from(utf8Fb2, "utf8"));
    expect(meta.title).toBe("Ар-Деко");
    expect(meta.authors).toEqual(["Дмитрий Круз", "Андрей Круз"]);
    expect(meta.language).toBe("ru");
    // FB2 genre code + free-form keywords become subjects (→ category + tags).
    expect(meta.subjects).toEqual(["sf_action", "боевик", "фантастика"]);
    expect(meta.description).toBe("Краткое описание.");
    expect(meta.year).toBe(2009);
    expect(meta.coverBuffer?.toString("utf8")).toBe("JPEGDATA");
  });

  it("decodes a windows-1251 FB2 without mojibake", () => {
    const fb2 =
      `<?xml version="1.0" encoding="windows-1251"?>` +
      `<FictionBook><description><title-info>` +
      `<author><first-name>Михаил</first-name><last-name>Булгаков</last-name></author>` +
      `<book-title>Мастер и Маргарита</book-title><lang>ru</lang>` +
      `</title-info></description></FictionBook>`;
    const meta = parseFb2Metadata(win1251(fb2));
    expect(meta.title).toBe("Мастер и Маргарита");
    expect(meta.authors).toEqual(["Михаил Булгаков"]);
  });

  it("falls back to <nickname> when an author has no real-name parts", () => {
    const fb2 =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<FictionBook><description><title-info>` +
      `<author><nickname>max1024</nickname></author>` +
      `<book-title>Anon</book-title>` +
      `</title-info></description></FictionBook>`;
    const meta = parseFb2Metadata(Buffer.from(fb2, "utf8"));
    expect(meta.authors).toEqual(["max1024"]);
  });

  it("ignores <author>/<genre> outside <title-info> (e.g. body citations)", () => {
    const fb2 =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<FictionBook><description><title-info>` +
      `<genre>prose_classic</genre>` +
      `<author><first-name>Джордж</first-name><last-name>Оруэлл</last-name></author>` +
      `<book-title>1984</book-title>` +
      `</title-info></description>` +
      `<body><author>not a real author</author><genre>spam</genre></body>` +
      `</FictionBook>`;
    const meta = parseFb2Metadata(Buffer.from(fb2, "utf8"));
    expect(meta.authors).toEqual(["Джордж Оруэлл"]);
    expect(meta.subjects).toEqual(["prose_classic"]);
  });
});
