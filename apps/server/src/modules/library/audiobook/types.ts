export interface AudiobookLibraryRow {
  id: string;
  name: string;
  type: "audiobook";
  source_path: string;
  settings_json: string;
  scan_status: "idle" | "scanning" | "error";
  last_scanned_at: string | null;
  created_at: string;
  updated_at: string;
  book_count: number;
  file_count: number;
}

export interface AudiobookBookRow {
  id: string;
  library_id: string;
  folder_path: string;
  status: "pending" | "ready" | "error";
  discovered_at: string;
  updated_at: string;
  deleted_at: string | null;
  title: string | null;
  sort_title: string | null;
  language: string | null;
  duration_seconds: number | null;
  cover_storage_key: string | null;
  publisher: string | null;
  asin: string | null;
  author_names: string | null;
  narrator_names: string | null;
  genre_names: string | null;
  file_count: number;
  total_size: number | null;
}

export interface BookFileRow {
  id: string;
  relative_path: string;
  mime_type: string | null;
  track_number: number | null;
  chapter_title: string | null;
  duration_seconds: number | null;
  size: number | null;
  modified_at: string | null;
  status: "available" | "missing";
}
