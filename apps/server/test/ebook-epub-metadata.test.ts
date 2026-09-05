import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { afterEach, describe, expect, it } from "vitest";
import { extractEpubMetadata } from "../src/modules/library/ebook/scanner.js";

// Builds the smallest EPUB the extractor will read: a container pointing at an
// OPF, and the OPF itself. `metadata` is spliced in verbatim so a test can put
// exactly the bytes a real file would carry.
const made: string[] = [];
function epub(metadata: string): string {
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${metadata}</metadata>
</package>`;
  const zip = new AdmZip();
  zip.addFile("META-INF/container.xml", Buffer.from(
    `<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`, "utf8"
  ));
  zip.addFile("content.opf", Buffer.from(opf, "utf8"));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "epubmeta-")), "book.epub");
  zip.writeZip(file);
  made.push(path.dirname(file));
  return file;
}

afterEach(() => {
  while (made.length) fs.rmSync(made.pop()!, { recursive: true, force: true });
});

describe("extractEpubMetadata", () => {
  it("reads the plain fields", () => {
    const meta = extractEpubMetadata(epub(`
      <dc:title>Alice's Adventures in Wonderland</dc:title>
      <dc:creator>Lewis Carroll</dc:creator>
      <dc:language>en</dc:language>
      <dc:subject>Fantasy</dc:subject>
      <dc:date>1865-01-01</dc:date>`));
    expect(meta?.title).toBe("Alice's Adventures in Wonderland");
    expect(meta?.authors).toEqual(["Lewis Carroll"]);
    expect(meta?.language).toBe("en");
    expect(meta?.subjects).toEqual(["Fantasy"]);
    expect(meta?.year).toBe(1865);
  });

  // The bug this test was written for: Standard Ebooks escapes a paragraph of
  // HTML into dc:description, entity decoding turned it back into real tags, and
  // the book page printed them as visible angle brackets.
  it("strips HTML that dc:description carried as entities", () => {
    const meta = extractEpubMetadata(epub(
      `<dc:description>&lt;p&gt;Everyone's familiar with `
      + `&lt;a href="https://standardebooks.org/ebooks/lewis-carroll"&gt;Lewis Carroll&lt;/a&gt;'s `
      + `famous children's classic, and the &lt;i&gt;nonsensical&lt;/i&gt; style.&lt;/p&gt;</dc:description>`
    ));
    expect(meta?.description).toBe(
      "Everyone's familiar with Lewis Carroll's famous children's classic, and the nonsensical style."
    );
    expect(meta?.description).not.toMatch(/[<>]/);
  });

  it("strips markup that dc:description carried as real tags", () => {
    const meta = extractEpubMetadata(epub(
      `<dc:description><![CDATA[<p>A book <b>worth</b> reading.</p>]]></dc:description>`
    ));
    expect(meta?.description).toBe("A book worth reading.");
  });

  it("leaves an already-plain description alone", () => {
    const meta = extractEpubMetadata(epub(`<dc:description>Just a sentence.</dc:description>`));
    expect(meta?.description).toBe("Just a sentence.");
  });

  it("reports no description rather than an empty one when the markup was all there was", () => {
    const meta = extractEpubMetadata(epub(`<dc:description>&lt;p&gt;&lt;/p&gt;</dc:description>`));
    expect(meta?.description).toBeNull();
  });
});
