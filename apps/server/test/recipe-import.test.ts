import { describe, expect, it } from "vitest";
import {
  cleanText,
  durationToMinutes,
  flattenInstructions,
  importRecipeFromUrl,
  parseRecipeHtml,
  RecipeImportError
} from "../src/modules/stories/recipe-import.js";

const SOURCE = "https://example.com/recipes/draniki";

function page(...blocks: unknown[]): string {
  const scripts = blocks
    .map((block) => `<script type="application/ld+json">${typeof block === "string" ? block : JSON.stringify(block)}</script>`)
    .join("\n");
  return `<!doctype html><html><head><title>Draniki</title>${scripts}</head><body><h1>Draniki</h1></body></html>`;
}

describe("parseRecipeHtml", () => {
  it("reads a plain Recipe object: strings for ingredients, HowToStep objects for steps", () => {
    const html = page({
      "@context": "https://schema.org",
      "@type": "Recipe",
      name: "Draniki",
      description: "Belarusian potato pancakes, <b>crisp</b> at the edges.",
      recipeIngredient: ["6 potatoes", "1 onion", "salt"],
      recipeInstructions: [
        { "@type": "HowToStep", text: "Grate the potatoes and the onion." },
        { "@type": "HowToStep", text: "Fry in hot oil until golden." }
      ],
      recipeYield: "4 servings",
      totalTime: "PT45M",
      image: ["https://example.com/img/draniki.jpg"]
    });
    const recipe = parseRecipeHtml(html, SOURCE);
    expect(recipe).toEqual({
      title: "Draniki",
      description: "Belarusian potato pancakes, crisp at the edges.",
      ingredients: ["6 potatoes", "1 onion", "salt"],
      steps: ["Grate the potatoes and the onion.", "Fry in hot oil until golden."],
      servings: "4 servings",
      cookMinutes: 45,
      imageUrl: "https://example.com/img/draniki.jpg",
      sourceUrl: SOURCE
    });
  });

  it("finds the Recipe inside an @graph, with @type given as a list", () => {
    const html = page({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", name: "Example Kitchen" },
        { "@type": "WebPage", name: "Draniki page" },
        {
          "@type": ["Recipe", "NewsArticle"],
          name: "Draniki",
          recipeIngredient: ["potatoes"],
          recipeInstructions: "Grate.\nFry.",
          prepTime: "PT15M",
          cookTime: "PT1H",
          image: { "@type": "ImageObject", url: "https://example.com/d.jpg" }
        }
      ]
    });
    const recipe = parseRecipeHtml(html, SOURCE)!;
    expect(recipe.title).toBe("Draniki");
    expect(recipe.steps).toEqual(["Grate.", "Fry."]);
    // No totalTime: prep + cook.
    expect(recipe.cookMinutes).toBe(75);
    expect(recipe.imageUrl).toBe("https://example.com/d.jpg");
  });

  it("flattens HowToSection groups, keeping the section name as its own line", () => {
    const html = page({
      "@type": "Recipe",
      name: "Layered",
      recipeIngredient: ["a", "b"],
      recipeInstructions: [
        {
          "@type": "HowToSection",
          name: "For the sauce",
          itemListElement: [{ "@type": "HowToStep", text: "Simmer." }, { "@type": "HowToStep", text: "Strain." }]
        },
        { "@type": "HowToSection", name: "To finish", itemListElement: ["Plate it."] }
      ]
    });
    expect(parseRecipeHtml(html, SOURCE)!.steps).toEqual(["For the sauce:", "Simmer.", "Strain.", "To finish:", "Plate it."]);
  });

  it("skips a malformed JSON-LD block and still reads the good one", () => {
    const html = page("{ this is not json", { "@type": "Recipe", name: "Still here", recipeIngredient: ["x"] });
    expect(parseRecipeHtml(html, SOURCE)!.title).toBe("Still here");
  });

  it("returns null for a page with no Recipe", () => {
    expect(parseRecipeHtml(page({ "@type": "Article", name: "Not food" }), SOURCE)).toBeNull();
    expect(parseRecipeHtml("<html><body>plain</body></html>", SOURCE)).toBeNull();
  });

  it("tolerates a script tag with extra attributes and single quotes", () => {
    const html = `<script id='ld' type='application/ld+json' data-x="1">${JSON.stringify({
      "@type": "Recipe", name: "Quoted", recipeIngredient: ["y"]
    })}</script>`;
    expect(parseRecipeHtml(html, SOURCE)!.title).toBe("Quoted");
  });
});

describe("helpers", () => {
  it("cleanText strips tags, decodes entities, and collapses whitespace", () => {
    expect(cleanText("  Salt &amp; pepper,<br> 1&frac12; tsp &#8212; to taste  ")).toBe("Salt & pepper,\n1&frac12; tsp — to taste");
    expect(cleanText(42)).toBe("");
  });

  it("cleanText leaves no tag behind, however it was hidden", () => {
    // An encoded tag decodes into a tag — so tags are stripped again afterwards.
    expect(cleanText("Heat &lt;script&gt;alert(1)&lt;/script&gt; gently")).toBe("Heat alert(1) gently");
    // A tag split by another tag reassembles after one pass; stripping repeats until it is gone.
    expect(cleanText("<scr<b>ipt>alert(1)</scr</b>ipt>")).toBe("alert(1)");
    // A lone "<" that is not a tag (a temperature) survives.
    expect(cleanText("cook at &lt;200°C")).toBe("cook at <200°C");
  });

  it("flattenInstructions accepts a bare string and a list of strings", () => {
    expect(flattenInstructions("One.\nTwo.")).toEqual(["One.", "Two."]);
    expect(flattenInstructions(["One.", "", "Two."])).toEqual(["One.", "Two."]);
  });

  it("durationToMinutes reads ISO-8601 durations and rejects the rest", () => {
    expect(durationToMinutes("PT45M")).toBe(45);
    expect(durationToMinutes("PT1H30M")).toBe(90);
    expect(durationToMinutes("P1DT2H")).toBe(1560);
    expect(durationToMinutes("PT90S")).toBe(2);
    expect(durationToMinutes("PT0M")).toBeNull();
    expect(durationToMinutes("45 minutes")).toBeNull();
    expect(durationToMinutes(undefined)).toBeNull();
  });
});

describe("importRecipeFromUrl", () => {
  it("rejects non-http links before touching the network", async () => {
    await expect(importRecipeFromUrl("ftp://example.com/x")).rejects.toMatchObject({ statusCode: 400 });
    await expect(importRecipeFromUrl("not a url")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses a private address through the safe fetcher", async () => {
    const err = await importRecipeFromUrl("http://127.0.0.1/recipe").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecipeImportError);
    expect((err as RecipeImportError).statusCode).toBe(502);
  });
});
