import type { LibraryKind } from "./layout-model";

export interface ScanRule {
  id: string;
  libraryId: string;
  name: string;
  enabled: boolean;
  preset: string | null;
  layouts: string[];
  paths: string[];
  isDefault: boolean;
  lastScannedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Stats the list endpoint adds.
  books: number;
  unmatched: number;
  missingFolders: string[];
}

export type PreviewChange = "new" | "unchanged" | "moves-from-default" | "added-without-fields" | `moves-from-rule:${string}` | `merges:${number}`;

export interface PreviewRow {
  path: string;
  matched: boolean;
  layoutIndex: number | null;
  author?: string;
  series?: string;
  position?: number;
  title?: string;
  narrator?: string;
  year?: number;
  publisher?: string;
  formats?: string[];
  tracks?: number;
  warnings: string[];
  change: PreviewChange;
}

export interface FolderOwnership { ruleId: string; name: string; enabled: boolean; exact: boolean }

export interface BrowseFolder { name: string; relativePath: string; books: number; ownedBy: FolderOwnership | null }

export interface FoldersResponse {
  path: string;
  parent: string | null;
  folders: BrowseFolder[];
  books: number;
  ownedBy: FolderOwnership | null;
  totalBooks: number;
}

export interface LayoutLibrary {
  id: string;
  name: string;
  type: LibraryKind;
}

export const rulesBase = (libraryId: string) => `/api/library/libraries/${libraryId}/scan-rules`;
export const foldersBase = (libraryId: string) => `/api/library/libraries/${libraryId}/folders`;
