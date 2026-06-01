// App-defined audiobook navigation categories + the keyword aliases the scanner
// uses to map messy/multilingual genre tags onto them. Pure data (no db import).
//
// `general_other` is the fallback bucket and intentionally has no aliases.

export interface CategorySeed {
  key: string;
  name: string;
  sortOrder: number;
  icon: string;
}

export interface AliasSeed {
  keyword: string;   // normalized (lowercase) substring tested against incoming genres
  category: string;  // CategorySeed.key
  priority: number;  // higher wins when a book matches several categories
}

export const CATEGORY_SEED: CategorySeed[] = [
  { key: "fiction", name: "Fiction", sortOrder: 1, icon: "book-open" },
  { key: "mystery_thriller", name: "Mystery & Thriller", sortOrder: 2, icon: "search" },
  { key: "scifi_fantasy", name: "Sci-Fi & Fantasy", sortOrder: 3, icon: "rocket" },
  { key: "romance", name: "Romance", sortOrder: 4, icon: "heart" },
  { key: "bio_history", name: "Biographies & History", sortOrder: 5, icon: "landmark" },
  { key: "selfhelp_business", name: "Self-Help & Business", sortOrder: 6, icon: "briefcase" },
  { key: "science_culture", name: "Science & Culture", sortOrder: 7, icon: "flask-conical" },
  { key: "kids_teens", name: "Kids & Teens", sortOrder: 8, icon: "baby" },
  { key: "general_other", name: "General / Other", sortOrder: 99, icon: "layout-grid" }
];

// Priorities: kids/teens wins over everything (a children's book stays a children's
// book), specific genres beat generic "fiction".
const P_KIDS = 40;
const P_SPECIFIC = 20;
const P_TOPIC = 15;
const P_FICTION = 5;

export const ALIAS_SEED: AliasSeed[] = [
  // Kids & Teens (highest priority)
  ...["children", "child", "kids", "juvenile", "young adult", "middle grade", "teen",
      "детск", "подростк", "сказк", "для детей", "юношес"].map((keyword) => ({ keyword, category: "kids_teens", priority: P_KIDS })),

  // Mystery & Thriller
  ...["mystery", "thriller", "detective", "suspense", "crime", "noir", "whodunit",
      "детектив", "триллер", "криминал", "иронический детектив"].map((keyword) => ({ keyword, category: "mystery_thriller", priority: P_SPECIFIC })),

  // Sci-Fi & Fantasy
  ...["sci-fi", "sci fi", "scifi", "science fiction", "fantasy", "cyberpunk", "space opera",
      "dystopia", "litrpg", "фантаст", "фэнтези", "космоопера", "киберпанк", "попадан",
      "литрпг", "антиутопи", "мистика"].map((keyword) => ({ keyword, category: "scifi_fantasy", priority: P_SPECIFIC })),

  // Romance
  ...["romance", "romantic", "love story", "любовн", "романтик", "мелодрам"].map((keyword) => ({ keyword, category: "romance", priority: P_SPECIFIC })),

  // Biographies & History
  ...["biography", "biographies", "memoir", "autobiography", "history", "historical",
      "биограф", "мемуар", "автобиограф", "истори"].map((keyword) => ({ keyword, category: "bio_history", priority: P_TOPIC })),

  // Self-Help & Business
  ...["self-help", "self help", "business", "finance", "personal development", "psychology",
      "health", "career", "management", "motivation",
      "саморазвит", "бизнес", "финанс", "психолог", "здоровь", "мотивац", "карьер"].map((keyword) => ({ keyword, category: "selfhelp_business", priority: P_TOPIC })),

  // Science & Culture
  ...["science", "popular science", "philosophy", "true crime", "politics", "culture",
      "religion", "current events", "education",
      "наука", "научно-популярн", "научпоп", "философ", "публицистик", "культур", "религ", "образован"].map((keyword) => ({ keyword, category: "science_culture", priority: P_TOPIC })),

  // Fiction (generic, lowest priority)
  ...["fiction", "novel", "literary", "contemporary", "drama", "classic", "short stories",
      "проза", "роман", "классик", "современная проза", "рассказ", "повесть"].map((keyword) => ({ keyword, category: "fiction", priority: P_FICTION }))
];
