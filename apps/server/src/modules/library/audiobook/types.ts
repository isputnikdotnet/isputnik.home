import type { AudioFileRow, AudiobookDetailRow, ItemMetadataRow, LibraryItemRow, LibraryRow, Nullable } from "../../../db/rows.js";

// `libraries.*` plus the list query's counts; the query filters to type = 'audiobook'.
export type AudiobookLibraryRow = Omit<LibraryRow, "type"> & {
  type: "audiobook";
  book_count: number;
  file_count: number;
  total_size_bytes: number;
};

// The columns both audiobook row queries return: the detail query
// (getAudiobookBookDetail) and BOOK_LIST_COLUMNS.
export type AudiobookBookRow =
  Pick<LibraryItemRow, "id" | "library_id" | "folder_path" | "status" | "discovered_at" | "updated_at" | "deleted_at">
  & Nullable<Pick<ItemMetadataRow, "title" | "sort_title" | "language" | "cover_storage_key" | "publisher">>
  & Nullable<Pick<AudiobookDetailRow, "duration_seconds" | "asin">>
  & {
    // item_metadata.updated_at — the version stamp on the cover URL (see coverUrl).
    metadata_updated_at: ItemMetadataRow["updated_at"] | null;
    author_names: string | null;
    narrator_names: string | null;
    total_size: number | null;
  };

export type BookFileRow = Pick<AudioFileRow, "id" | "relative_path" | "mime_type" | "track_number" | "duration_seconds" | "size" | "modified_at" | "status"> & {
  chapter_title: AudioFileRow["title"];
};
