import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATEGORY_SEED,
  builtinCategoryImageUrl,
  isBuiltinCategoryImageKey
} from "../src/categories-seed.js";

// The built-in category art moved from 1254px PNGs to 512px WebP. The storage
// key is persisted in categories.image_storage_key, so installs seeded before
// the move still hold the old "...-v1.png" form and there is no migration to
// rewrite them — builtinCategoryImageUrl() has to resolve both shapes onto the
// file that actually ships. These tests pin that, and pin that the file is
// really there for every seeded category.

const assetsDir = fileURLToPath(new URL("../../web/public/Assets/categories", import.meta.url));

describe("builtinCategoryImageUrl", () => {
  it("resolves a current, extensionless key", () => {
    expect(builtinCategoryImageUrl("builtin-category:fiction-v1"))
      .toBe("/Assets/categories/fiction-v1.webp");
  });

  it("resolves a legacy .png key from a pre-WebP install", () => {
    expect(builtinCategoryImageUrl("builtin-category:fiction-v1.png"))
      .toBe("/Assets/categories/fiction-v1.webp");
  });

  it("is idempotent for a key that already names the webp", () => {
    expect(builtinCategoryImageUrl("builtin-category:fiction-v1.webp"))
      .toBe("/Assets/categories/fiction-v1.webp");
  });

  it("leaves a name that merely contains a dot alone", () => {
    expect(builtinCategoryImageUrl("builtin-category:sci-fi-v1.2"))
      .toBe("/Assets/categories/sci-fi-v1.2.webp");
  });
});

describe("category seed art", () => {
  const seeded = CATEGORY_SEED.filter((c) => c.defaultImageStorageKey);

  it("seeds art for most categories", () => {
    expect(seeded.length).toBeGreaterThan(10);
  });

  it("ships a file for every seeded key", () => {
    const missing = seeded
      .map((c) => builtinCategoryImageUrl(c.defaultImageStorageKey!))
      .filter((url) => !fs.existsSync(path.join(assetsDir, path.basename(url))));
    expect(missing).toEqual([]);
  });

  it("marks every seeded key as built-in", () => {
    for (const category of seeded) {
      expect(isBuiltinCategoryImageKey(category.defaultImageStorageKey!)).toBe(true);
    }
  });

  it("leaves an uploaded key alone", () => {
    expect(isBuiltinCategoryImageKey("cat-abc123.jpg")).toBe(false);
    expect(isBuiltinCategoryImageKey(null)).toBe(false);
  });
});
