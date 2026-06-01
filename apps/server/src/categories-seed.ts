// App-defined audiobook navigation categories + the keyword aliases the scanner
// uses to map messy genre tags onto them. Pure data (no db import).
//
// `general_other` is the fallback bucket and intentionally has no aliases.

export interface CategorySeed {
  key: string;
  name: string;
  sortOrder: number;
  icon: string;
  defaultImageStorageKey?: string;
}

export interface AliasSeed {
  keyword: string;   // normalized (lowercase) substring tested against incoming genres
  category: string;  // CategorySeed.key
  priority: number;  // higher wins when a book matches several categories
}

export const BUILTIN_CATEGORY_IMAGE_PREFIX = "builtin-category:";

export function isBuiltinCategoryImageKey(value: string | null): value is string {
  return !!value && value.startsWith(BUILTIN_CATEGORY_IMAGE_PREFIX);
}

export function builtinCategoryImageUrl(value: string) {
  return `/Assets/categories/${value.slice(BUILTIN_CATEGORY_IMAGE_PREFIX.length)}`;
}

export const CATEGORY_SEED: CategorySeed[] = [
  { key: "fiction", name: "Fiction", sortOrder: 1, icon: "book-open", defaultImageStorageKey: `${BUILTIN_CATEGORY_IMAGE_PREFIX}fiction-v1.png` },
  { key: "classics_literary", name: "Classics & Literary", sortOrder: 2, icon: "drama" },
  { key: "adventure_action", name: "Adventure & Action", sortOrder: 3, icon: "compass" },
  { key: "mystery_thriller", name: "Mystery & Thriller", sortOrder: 4, icon: "search" },
  { key: "scifi_fantasy", name: "Sci-Fi & Fantasy", sortOrder: 5, icon: "rocket" },
  { key: "horror_supernatural", name: "Horror & Supernatural", sortOrder: 6, icon: "ghost" },
  { key: "romance", name: "Romance", sortOrder: 7, icon: "heart" },
  { key: "humor_satire", name: "Humor & Satire", sortOrder: 8, icon: "laugh" },
  { key: "biographies_memoirs", name: "Biographies & Memoirs", sortOrder: 9, icon: "mic" },
  { key: "history", name: "History", sortOrder: 10, icon: "landmark" },
  { key: "selfhelp_business", name: "Self-Help & Business", sortOrder: 11, icon: "briefcase" },
  { key: "science_culture", name: "Science & Culture", sortOrder: 12, icon: "flask-conical" },
  { key: "kids_teens", name: "Kids & Teens", sortOrder: 13, icon: "baby" },
  { key: "general_other", name: "General / Other", sortOrder: 99, icon: "layout-grid" }
];

// Priorities: kids/teens wins over everything (a children's book stays a children's
// book), specific genres beat generic "fiction".
const P_KIDS = 50;
const P_GENRE = 30;
const P_TOPIC = 20;
const P_FICTION = 5;

export const ALIAS_SEED: AliasSeed[] = [
  // Kids & Teens (highest priority)
  ...["children", "child", "kids", "juvenile", "young adult", "ya", "middle grade", "teen",
      "children's literature"].map((keyword) => ({ keyword, category: "kids_teens", priority: P_KIDS })),

  // Classics & Literary
  ...["classic", "classics", "literary", "literary fiction", "literature", "modern literature",
      "modern classics", "contemporary literature", "drama"].map((keyword) => ({ keyword, category: "classics_literary", priority: P_GENRE })),

  // Adventure & Action
  ...["adventure", "action", "action adventure", "action & adventure", "survival", "western",
      "military fiction", "war fiction", "sea adventure", "travel adventure", "spy adventure"].map((keyword) => ({ keyword, category: "adventure_action", priority: P_GENRE })),

  // Mystery & Thriller
  ...["mystery", "thriller", "detective", "suspense", "crime", "noir", "whodunit",
      "legal thriller", "psychological thriller", "spy thriller", "espionage"].map((keyword) => ({ keyword, category: "mystery_thriller", priority: P_GENRE })),

  // Sci-Fi & Fantasy
  ...["sci-fi", "sci fi", "scifi", "science fiction", "science-fiction", "sf", "fantasy",
      "speculative", "cyberpunk", "space opera", "dystopia", "utopia", "litrpg",
      "alternate history", "time travel", "post-apocalyptic", "urban fantasy"].map((keyword) => ({ keyword, category: "scifi_fantasy", priority: P_GENRE })),

  // Horror & Supernatural
  ...["horror", "supernatural", "paranormal", "occult", "ghost story", "vampire", "zombie",
      "werewolf", "dark fantasy", "gothic", "weird fiction"].map((keyword) => ({ keyword, category: "horror_supernatural", priority: P_GENRE })),

  // Romance
  ...["romance", "romantic", "love story", "romantic comedy", "erotica"].map((keyword) => ({ keyword, category: "romance", priority: P_GENRE })),

  // Humor & Satire
  ...["humor", "humour", "comedy", "comic", "satire", "satirical", "funny"].map((keyword) => ({ keyword, category: "humor_satire", priority: P_GENRE })),

  // Biographies & Memoirs
  ...["biography", "biographies", "memoir", "memoirs", "autobiography", "personal narrative",
      "diary", "letters"].map((keyword) => ({ keyword, category: "biographies_memoirs", priority: P_TOPIC })),

  // History
  ...["history", "historical", "world war", "wwii", "military history", "ancient history",
      "middle ages"].map((keyword) => ({ keyword, category: "history", priority: P_TOPIC })),

  // Self-Help & Business
  ...["self-help", "self help", "business", "finance", "personal development", "psychology",
      "health", "career", "management", "motivation", "productivity", "leadership",
      "entrepreneurship", "investing", "wellness"].map((keyword) => ({ keyword, category: "selfhelp_business", priority: P_TOPIC })),

  // Science & Culture
  ...["science", "popular science", "philosophy", "true crime", "politics", "culture",
      "religion", "current events", "education", "social science", "sociology",
      "anthropology", "linguistics", "art", "music", "film", "essays", "technology",
      "medicine"].map((keyword) => ({ keyword, category: "science_culture", priority: P_TOPIC })),

  // Fiction (generic, lowest priority)
  ...["fiction", "novel", "contemporary", "short stories", "short story"].map((keyword) => ({ keyword, category: "fiction", priority: P_FICTION }))
];
