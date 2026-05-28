export const LIBRARY_TYPES = ["audiobook", "photo", "video"] as const;
export type LibraryType = typeof LIBRARY_TYPES[number];
