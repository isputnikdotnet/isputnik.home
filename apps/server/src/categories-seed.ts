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

function builtinCategoryImage(fileName: string) {
  return `${BUILTIN_CATEGORY_IMAGE_PREFIX}${fileName}`;
}

export const CATEGORY_SEED: CategorySeed[] = [
  { key: "fiction", name: "General Fiction", sortOrder: 1, icon: "book-open", defaultImageStorageKey: builtinCategoryImage("fiction-v1.png") },
  { key: "classics_literary", name: "Classics & Literary", sortOrder: 2, icon: "drama", defaultImageStorageKey: builtinCategoryImage("classics-literary-v1.png") },
  { key: "adventure_action", name: "Adventure & Action", sortOrder: 3, icon: "compass", defaultImageStorageKey: builtinCategoryImage("adventure-action-v1.png") },
  { key: "mystery_thriller", name: "Mystery & Thriller", sortOrder: 4, icon: "search", defaultImageStorageKey: builtinCategoryImage("mystery-thriller-v1.png") },
  { key: "scifi_fantasy", name: "Sci-Fi & Fantasy", sortOrder: 5, icon: "rocket", defaultImageStorageKey: builtinCategoryImage("scifi-fantasy-v1.png") },
  { key: "horror_supernatural", name: "Horror & Supernatural", sortOrder: 6, icon: "ghost", defaultImageStorageKey: builtinCategoryImage("horror-supernatural-v1.png") },
  { key: "romance", name: "Romance", sortOrder: 7, icon: "heart", defaultImageStorageKey: builtinCategoryImage("romance-v1.png") },
  { key: "humor_satire", name: "Humor & Satire", sortOrder: 8, icon: "laugh", defaultImageStorageKey: builtinCategoryImage("humor-satire-v1.png") },
  { key: "biographies_memoirs", name: "Biographies & Memoirs", sortOrder: 9, icon: "mic", defaultImageStorageKey: builtinCategoryImage("biographies-memoirs-v1.png") },
  { key: "history", name: "History", sortOrder: 10, icon: "landmark", defaultImageStorageKey: builtinCategoryImage("history-v1.png") },
  { key: "true_crime", name: "True Crime", sortOrder: 11, icon: "fingerprint" },
  { key: "science_culture", name: "Science & Culture", sortOrder: 12, icon: "flask-conical", defaultImageStorageKey: builtinCategoryImage("science-culture-v1.png") },
  { key: "religion_spirituality", name: "Religion & Spirituality", sortOrder: 13, icon: "church" },
  { key: "selfhelp_business", name: "Self-Help & Business", sortOrder: 14, icon: "briefcase", defaultImageStorageKey: builtinCategoryImage("selfhelp-business-v1.png") },
  { key: "kids_teens", name: "Kids & Teens", sortOrder: 15, icon: "baby", defaultImageStorageKey: builtinCategoryImage("kids-teens-v1.png") },
  { key: "general_other", name: "General / Other", sortOrder: 99, icon: "layout-grid", defaultImageStorageKey: builtinCategoryImage("general-other-v1.png") }
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

  // Classics & Literary. "historical fiction" is deliberately genre-priority so it wins
  // over the "historical" -> History (non-fiction) topic keyword — a historical novel is
  // fiction, not a history book.
  ...["classic", "classics", "literary", "literary fiction", "literature", "modern literature",
      "modern classics", "contemporary literature", "drama", "bildungsroman", "epic poetry",
      "historical fiction"].map((keyword) => ({ keyword, category: "classics_literary", priority: P_GENRE })),

  // Adventure & Action
  ...["adventure", "action", "action adventure", "action & adventure", "survival", "western",
      "military fiction", "war fiction", "war stories", "sea adventure", "sea stories",
      "travel adventure", "spy adventure"].map((keyword) => ({ keyword, category: "adventure_action", priority: P_GENRE })),

  // Mystery & Thriller
  ...["mystery", "thriller", "detective", "private investigator", "suspense", "crime", "noir", "whodunit",
      "legal thriller", "psychological thriller", "spy thriller", "espionage"].map((keyword) => ({ keyword, category: "mystery_thriller", priority: P_GENRE })),

  // Sci-Fi & Fantasy
  ...["sci-fi", "sci fi", "scifi", "science fiction", "science-fiction", "sf", "fantasy",
      "speculative", "cyberpunk", "space opera", "dystopia", "utopia", "litrpg",
      "alternate history", "time travel", "post-apocalyptic", "urban fantasy"].map((keyword) => ({ keyword, category: "scifi_fantasy", priority: P_GENRE })),

  // Horror & Supernatural
  ...["horror", "supernatural", "paranormal", "occult", "ghost story", "vampire", "zombie",
      "werewolf", "dark fantasy", "gothic", "weird fiction"].map((keyword) => ({ keyword, category: "horror_supernatural", priority: P_GENRE })),

  // Romance
  ...["romance", "romantic", "love story", "love stories", "regency", "romantic comedy", "erotica"].map((keyword) => ({ keyword, category: "romance", priority: P_GENRE })),

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
      "entrepreneurship", "investing", "wellness", "nutrition", "diet", "personal success"].map((keyword) => ({ keyword, category: "selfhelp_business", priority: P_TOPIC })),

  // Science & Culture
  ...["science", "popular science", "philosophy", "ethics", "politics", "culture",
      "current events", "education", "social science", "sociology",
      "anthropology", "linguistics", "art", "music", "film", "essays", "technology",
      "medicine"].map((keyword) => ({ keyword, category: "science_culture", priority: P_TOPIC })),

  // True Crime (split out of Science & Culture — a distinct, popular shelf)
  ...["true crime"].map((keyword) => ({ keyword, category: "true_crime", priority: P_TOPIC })),

  // Religion & Spirituality (split out of Science & Culture). Keep keywords specific —
  // short stems like "faith" would false-match fiction ("unfaithful"), so they're avoided.
  ...["religion", "religious", "spirituality", "spiritual", "theology", "meditation",
      "buddhism", "christianity", "islam", "hinduism", "judaism"].map((keyword) => ({ keyword, category: "religion_spirituality", priority: P_TOPIC })),

  // Fiction (generic, lowest priority)
  ...["fiction", "novel", "contemporary", "short stories", "short story"].map((keyword) => ({ keyword, category: "fiction", priority: P_FICTION }))
];
