// Recipe import from a link (docs/recipes-plan.md, phase 3): paste a URL, get
// the text of a recipe story. Most recipe sites publish schema.org `Recipe`
// as JSON-LD, so the whole parser is "find the script tags, find the Recipe
// object, flatten its fields to plain lines". Nothing is downloaded into the
// library — not even the dish photo (the CSP allowlist covers metadata
// providers, not arbitrary sites, and a proxy would reopen the remote-image
// path deliberately closed) — and the fetch goes through the same SSRF-safe
// door as every other outbound request.
import { fetchTextFromUrl } from "../library/shared/remote-image.js";

export interface ImportedRecipe {
  title: string | null;
  /** The page's own summary, for the subtitle. */
  description: string | null;
  ingredients: string[];
  steps: string[];
  /** Free text, as the site wrote it ("4 servings", "6"). */
  servings: string | null;
  /** Total time in minutes (totalTime, else prep + cook). */
  cookMinutes: number | null;
  /** The dish photo's URL, for linking only — never fetched or shown. */
  imageUrl: string | null;
  sourceUrl: string;
}

export class RecipeImportError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_INGREDIENTS = 200;
const MAX_STEPS = 100;

type Json = Record<string, unknown>;

/** Everything between `<script type="application/ld+json">` tags, parsed
 *  where it parses — a site with one broken block still yields the others. */
function jsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const pattern = /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(pattern)) {
    try {
      blocks.push(JSON.parse(match[1].trim()));
    } catch {
      // Malformed block: skip it rather than fail the page.
    }
  }
  return blocks;
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasType(node: Json, type: string): boolean {
  const declared = node["@type"];
  if (typeof declared === "string") return declared === type;
  return Array.isArray(declared) && declared.includes(type);
}

/** Depth-first for the first `Recipe` node: top level, inside `@graph`, or
 *  nested in a container (`mainEntity`, a WebPage's `about`, …). */
function findRecipe(node: unknown, depth = 0): Json | null {
  if (depth > 6) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRecipe(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isObject(node)) return null;
  if (hasType(node, "Recipe")) return node;
  for (const value of Object.values(node)) {
    if (typeof value !== "object" || value === null) continue;
    const found = findRecipe(value, depth + 1);
    if (found) return found;
  }
  return null;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'", "#x27": "'", "#160": " "
};

/** Sites put HTML in text fields more often than the spec allows. Strip tags,
 *  decode the common entities, collapse whitespace. */
export function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|div)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#?\w+);/g, (whole, name: string) => {
      if (ENTITIES[name] !== undefined) return ENTITIES[name];
      if (/^#\d+$/.test(name)) return String.fromCodePoint(Number(name.slice(1)));
      if (/^#x[0-9a-f]+$/i.test(name)) return String.fromCodePoint(parseInt(name.slice(2), 16));
      return whole;
    })
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** One line per item, however the site shaped the list. */
function textLines(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(textLines);
  if (isObject(value)) return textLines(value.text ?? value.name ?? "");
  return cleanText(value).split("\n").map((line) => line.trim()).filter(Boolean);
}

/** `recipeInstructions` comes as a string, a list of strings, a list of
 *  HowToStep objects, or HowToSection groups holding either — flattened to
 *  one step per line in reading order. Section names become their own line
 *  so "For the sauce:" survives the flattening. */
export function flattenInstructions(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(flattenInstructions);
  if (isObject(value)) {
    if (hasType(value, "HowToSection") || Array.isArray(value.itemListElement)) {
      const heading = cleanText(value.name);
      return [...(heading ? [`${heading}:`] : []), ...flattenInstructions(value.itemListElement)];
    }
    return textLines(value.text ?? value.name ?? value.description ?? "");
  }
  return textLines(value);
}

/** ISO-8601 duration (`PT1H30M`, `P0DT0H45M`, `PT45M`) → whole minutes, or
 *  null for anything unparseable or zero. */
export function durationToMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  const total = Number(days ?? 0) * 1440 + Number(hours ?? 0) * 60 + Number(minutes ?? 0) + Number(seconds ?? 0) / 60;
  const rounded = Math.round(total);
  return rounded > 0 ? rounded : null;
}

function firstText(value: unknown): string | null {
  const [line] = textLines(value);
  return line ?? null;
}

function imageUrlOf(value: unknown): string | null {
  if (Array.isArray(value)) return value.length > 0 ? imageUrlOf(value[0]) : null;
  if (isObject(value)) return imageUrlOf(value.url ?? value.contentUrl ?? null);
  if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
  return null;
}

/** The pure half: HTML in, recipe out, or null when the page carries no
 *  schema.org Recipe. Exported for tests. */
export function parseRecipeHtml(html: string, sourceUrl: string): ImportedRecipe | null {
  const recipe = findRecipe(jsonLdBlocks(html));
  if (!recipe) return null;

  const cookMinutes = durationToMinutes(recipe.totalTime)
    ?? (() => {
      const prep = durationToMinutes(recipe.prepTime) ?? 0;
      const cook = durationToMinutes(recipe.cookTime) ?? 0;
      return prep + cook > 0 ? prep + cook : null;
    })();

  return {
    title: firstText(recipe.name),
    description: cleanText(recipe.description).replace(/\n+/g, " ").slice(0, 300) || null,
    ingredients: textLines(recipe.recipeIngredient ?? recipe.ingredients).slice(0, MAX_INGREDIENTS),
    steps: flattenInstructions(recipe.recipeInstructions).slice(0, MAX_STEPS),
    servings: firstText(recipe.recipeYield)?.slice(0, 60) ?? null,
    cookMinutes,
    imageUrl: imageUrlOf(recipe.image),
    sourceUrl
  };
}

/** Fetch the page (SSRF-pinned, size-capped) and parse it. Throws a
 *  RecipeImportError with the status the route should answer with. */
export async function importRecipeFromUrl(url: string): Promise<ImportedRecipe> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new RecipeImportError("That doesn't look like a web address.", 400);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new RecipeImportError("Only http(s) links can be imported.", 400);
  }

  let html: string;
  try {
    html = await fetchTextFromUrl(parsedUrl.toString(), {
      accept: "text/html,application/xhtml+xml",
      maxBytes: MAX_PAGE_BYTES
    });
  } catch (err) {
    throw new RecipeImportError(
      `Unable to read that page${err instanceof Error && err.message ? ` — ${err.message}` : "."}`,
      502
    );
  }

  const recipe = parseRecipeHtml(html, parsedUrl.toString());
  if (!recipe) {
    throw new RecipeImportError("That page has no recipe data the app can read.", 422);
  }
  if (recipe.ingredients.length === 0 && recipe.steps.length === 0) {
    throw new RecipeImportError("That page's recipe data has no ingredients or steps.", 422);
  }
  return recipe;
}
