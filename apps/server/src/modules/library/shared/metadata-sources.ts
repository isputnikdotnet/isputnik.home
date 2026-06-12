// Registry of scan metadata sources. A library stores an ordered subset of these in
// settings_json.scan_sources; the order is the priority (index 0 wins per field).
// Adding a new source = one entry here + an extractor in the relevant scanner(s).
import type { LibraryType } from "./library-types.js";

export const METADATA_SOURCE_IDS = ["file_metadata", "metadata_files", "folder_structure", "online_metadata"] as const;
export type MetadataSourceId = typeof METADATA_SOURCE_IDS[number];

export interface MetadataSourceDefinition {
  id: MetadataSourceId;
  label: string;
  description: string;
  appliesTo: LibraryType[];
  defaultEnabled: boolean;
  recommended?: boolean;
  // When enabled, this source also changes how files are grouped into books
  // (folder_structure: top-level folder = one book).
  affectsGrouping?: boolean;
}

export const METADATA_SOURCES: MetadataSourceDefinition[] = [
  {
    id: "file_metadata",
    label: "File metadata",
    description: "Scan files and extract embedded metadata (title, author, narrator, tags, etc.).",
    appliesTo: ["audiobook", "ebook"],
    defaultEnabled: true,
    recommended: true
  },
  {
    id: "metadata_files",
    label: "Folder metadata",
    description: "Read and store metadata from folders (e.g., .json, .nfo).",
    appliesTo: ["audiobook"],
    defaultEnabled: true
  },
  {
    id: "folder_structure",
    label: "Treat folder as book",
    description: "Each folder will be treated as a book. All audio files inside will be grouped together, regardless of author.",
    appliesTo: ["audiobook"],
    defaultEnabled: false,
    affectsGrouping: true
  },
  {
    id: "online_metadata",
    label: "Online lookup",
    description: "Look up missing details on the internet (LibriVox, Open Library): narrator, cover art, description, and author photos & bios. Only fills in what other sources left empty. Needs internet access and slows the scan down.",
    appliesTo: ["audiobook"],
    defaultEnabled: false
  }
];

export function sourcesForType(type: LibraryType): MetadataSourceDefinition[] {
  return METADATA_SOURCES.filter((source) => source.appliesTo.includes(type));
}

export function isMetadataSourceId(value: string): value is MetadataSourceId {
  return (METADATA_SOURCE_IDS as readonly string[]).includes(value);
}
