// Registry of scan metadata sources. A library stores an ordered subset of these in
// settings_json.scan_sources; the order is the priority (index 0 wins per field).
// Adding a new source = one entry here + an extractor in the relevant scanner(s).
import type { LibraryType } from "./library-types.js";

export const METADATA_SOURCE_IDS = ["file_metadata", "metadata_files", "folder_structure"] as const;
export type MetadataSourceId = typeof METADATA_SOURCE_IDS[number];

export interface MetadataSourceDefinition {
  id: MetadataSourceId;
  label: string;
  description: string;
  appliesTo: LibraryType[];
  defaultEnabled: boolean;
  // When enabled, this source also changes how files are grouped into books
  // (folder_structure: top-level folder = one book).
  affectsGrouping?: boolean;
}

export const METADATA_SOURCES: MetadataSourceDefinition[] = [
  {
    id: "metadata_files",
    label: "Metadata files in folders",
    description: "Read metadata.json files placed next to the book files.",
    appliesTo: ["audiobook"],
    defaultEnabled: true
  },
  {
    id: "file_metadata",
    label: "File metadata",
    description: "Read embedded metadata such as audio tags or EPUB details.",
    appliesTo: ["audiobook", "ebook"],
    defaultEnabled: true
  },
  {
    id: "folder_structure",
    label: "Folder structure",
    description: "Each top-level folder becomes a book; every file beneath it becomes a track. Folder and file names supply titles.",
    appliesTo: ["audiobook"],
    defaultEnabled: false,
    affectsGrouping: true
  }
];

export function sourcesForType(type: LibraryType): MetadataSourceDefinition[] {
  return METADATA_SOURCES.filter((source) => source.appliesTo.includes(type));
}

export function isMetadataSourceId(value: string): value is MetadataSourceId {
  return (METADATA_SOURCE_IDS as readonly string[]).includes(value);
}
