// generated — run npm run db:rows
//
// One interface per table, read from a database built by db/migrate.ts
// (scripts/gen-db-rows.mjs). Do not edit by hand: change schema.sql or add a
// migration, then regenerate. test/db-rows.test.ts fails when this file is stale.
//
// Use them for query results instead of restating a row's shape at the call
// site: `.get(id) as LibraryItemRow | undefined`, `.all() as Pick<UserRow, "id" | "email">[]`.
// A join is an intersection of Picks; a column renamed with AS is `ItemMetadataRow["title"]`.

/** A LEFT JOINed table's columns: with no match, every one of them comes back NULL. */
export type Nullable<T> = { [K in keyof T]: T[K] | null };

/** Columns the query itself keeps NULL out of (`WHERE col IS NOT NULL`, an inner join on it). */
export type NonNull<T, K extends keyof T> = Omit<T, K> & { [P in K]-?: NonNullable<T[P]> };

/** `activity_logs` */
export interface ActivityLogRow {
  id: string;
  event: string;
  actor_user_id: string | null;
  target_type: string | null;
  target_id: string | null;
  detail: string;
  ip_address: string | null;
  created_at: string;
}

/** `api_tokens` */
export interface ApiTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  scope: string;
  label: string | null;
  created_at: string;
  last_seen_at: string | null;
  last_ip: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

/** `app_settings` */
export interface AppSettingRow {
  key: string;
  value: string;
  updated_by: string | null;
  updated_at: string;
}

/** `assignments` */
export interface AssignmentRow {
  subject_type: "user" | "group";
  subject_id: string;
  object_type: string;
  object_id: string;
  role: "viewer" | "member" | "contributor" | "manager" | "deny";
  created_by: string | null;
  created_at: string;
}

/** `audio_bookmarks` */
export interface AudioBookmarkRow {
  id: string;
  user_id: string;
  item_id: string;
  file_id: string | null;
  position_seconds: number;
  item_position_seconds: number | null;
  label: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

/** `audio_chapters` */
export interface AudioChapterRow {
  id: string;
  audio_file_id: string;
  ordinal: number;
  title: string;
  start_seconds: number;
  end_seconds: number | null;
}

/** `audio_files` */
export interface AudioFileRow {
  id: string;
  item_id: string;
  relative_path: string;
  mime_type: string | null;
  track_number: number | null;
  title: string | null;
  duration_seconds: number | null;
  size: number | null;
  modified_at: string | null;
  content_hash: string | null;
  status: "available" | "missing";
  discovered_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** `audiobook_details` */
export interface AudiobookDetailRow {
  item_id: string;
  asin: string | null;
  duration_seconds: number | null;
}

/** `blocked_ips` */
export interface BlockedIpRow {
  ip_address: string;
  reason: string | null;
  auto: 0 | 1;
  created_at: string;
  expires_at: string | null;
  created_by: string | null;
}

/** `categories` */
export interface CategoryRow {
  id: string;
  key: string;
  name: string;
  slug: string | null;
  parent_id: string | null;
  sort_order: number;
  icon: string | null;
  image_storage_key: string | null;
}

/** `category_aliases` */
export interface CategoryAliasRow {
  id: string;
  keyword: string;
  category_id: string;
  priority: number;
}

/** `collection_items` */
export interface CollectionItemRow {
  id: string;
  collection_id: string;
  entity_type: string;
  entity_id: string;
  position: number;
  added_at: string;
}

/** `collections` */
export interface CollectionRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

/** `device_link_requests` */
export interface DeviceLinkRequestRow {
  id: string;
  device_code_hash: string;
  user_code: string;
  status: "pending" | "approved" | "denied" | "consumed";
  created_at: string;
  expires_at: string;
  attempts: number;
  user_agent: string | null;
  ip_address: string | null;
  approved_by: string | null;
  approved_at: string | null;
  session_id: string | null;
  remote: 0 | 1;
}

/** `device_link_windows` */
export interface DeviceLinkWindowRow {
  id: string;
  user_id: string;
  created_by: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  session_id: string | null;
  revoked_at: string | null;
}

/** `document_files` */
export interface DocumentFileRow {
  id: string;
  item_id: string;
  role: "content" | "companion";
  relative_path: string;
  format: string;
  mime_type: string | null;
  size: number | null;
  status: "available" | "missing";
  discovered_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** `duplicate_job_actions` */
export interface DuplicateJobActionRow {
  id: string;
  job_id: string;
  user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  status: string;
  details: string | null;
  created_at: string;
}

/** `duplicate_job_errors` */
export interface DuplicateJobErrorRow {
  id: string;
  job_id: string;
  target_type: string | null;
  target_id: string | null;
  error_code: string;
  message: string;
  created_at: string;
  resolved_at: string | null;
}

/** `duplicate_job_folder_preferences` */
export interface DuplicateJobFolderPreferenceRow {
  job_id: string;
  library_id: string;
  folder_path: string;
  preference: "keep" | "clear";
  updated_by: string | null;
  updated_at: string;
}

/** `duplicate_job_libraries` */
export interface DuplicateJobLibraryRow {
  job_id: string;
  library_id: string;
  included: 0 | 1;
  library_type_snapshot: string;
  protected_snapshot: 0 | 1;
}

/** `duplicate_job_result_folders` */
export interface DuplicateJobResultFolderRow {
  id: string;
  job_id: string;
  result_id: string;
  library_id: string;
  folder_path: string;
  role: "keep" | "delete" | "protected";
  item_count: number;
  bytes: number;
}

/** `duplicate_job_result_members` */
export interface DuplicateJobResultMemberRow {
  id: string;
  job_id: string;
  result_id: string;
  folder_id: string | null;
  item_id: string | null;
  library_id: string;
  path: string;
  size_snapshot: number | null;
  mtime_snapshot: string | null;
  content_hash: string | null;
  distance: number;
  role: "keep" | "delete" | "protected";
  status: "pending" | "deleted" | "skipped" | "missing" | "modified" | "error";
  keeper_member_id: string | null;
  created_at: string;
  updated_at: string;
}

/** `duplicate_job_results` */
export interface DuplicateJobResultRow {
  id: string;
  job_id: string;
  result_type: "photo_set" | "folder_set" | "contained" | "overlap";
  status: "active" | "resolved" | "protected" | "error";
  review_status: "unreviewed" | "reviewed" | "skipped";
  reclaimable_bytes: number;
  keeper_reason: string | null;
  match_confidence: "certain" | "likely" | "unsure";
  keeper_rank: number;
  created_at: string;
  updated_at: string;
}

/** `duplicate_jobs` */
export interface DuplicateJobRow {
  id: string;
  owner_user_id: string;
  status: "draft" | "scanning" | "review" | "processing" | "paused" | "completed" | "failed" | "cancelled";
  duplicate_type: "folders" | "files";
  media_type: "photo" | "video" | "both";
  inbox_library_id: string | null;
  current_step: number;
  scan_progress: number;
  status_detail: string | null;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  scan_started_at: string | null;
  scan_completed_at: string | null;
  completed_at: string | null;
}

/** `ebook_details` */
export interface EbookDetailRow {
  item_id: string;
  page_count: number | null;
}

/** `family_tree_children` */
export interface FamilyTreeChildRow {
  union_id: string;
  child_id: string;
  relation: "biological" | "adopted" | "step" | "foster" | "unknown";
  added_at: string;
}

/** `family_tree_citations` */
export interface FamilyTreeCitationRow {
  id: string;
  source_id: string;
  person_id: string | null;
  event_id: string | null;
  union_id: string | null;
  fact: "name" | "birth" | "death" | "marriage" | "divorce" | null;
  detail: string | null;
  url: string | null;
  note: string | null;
  created_at: string;
}

/** `family_tree_event_photos` */
export interface FamilyTreeEventPhotoRow {
  event_id: string;
  item_id: string;
  position: number;
  added_by: string | null;
  added_at: string;
}

/** `family_tree_events` */
export interface FamilyTreeEventRow {
  id: string;
  person_id: string;
  type: "residence" | "education" | "graduation" | "occupation" | "retirement" | "military" | "immigration" | "emigration" | "naturalization" | "travel" | "award" | "baptism" | "burial" | "custom";
  label: string | null;
  date: string | null;
  end_date: string | null;
  place: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

/** `family_tree_persons` */
export interface FamilyTreePersonRow {
  id: string;
  name: string;
  maiden_name: string | null;
  gender: "male" | "female" | "other" | "unknown";
  birth_date: string | null;
  death_date: string | null;
  birthplace: string | null;
  death_place: string | null;
  bio: string | null;
  portrait_storage_key: string | null;
  portrait_item_id: string | null;
  gallery_person_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** `family_tree_photos` */
export interface FamilyTreePhotoRow {
  person_id: string;
  item_id: string;
  position: number;
  added_by: string | null;
  added_at: string;
}

/** `family_tree_sources` */
export interface FamilyTreeSourceRow {
  id: string;
  title: string;
  author: string | null;
  publisher: string | null;
  url: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

/** `family_tree_unions` */
export interface FamilyTreeUnionRow {
  id: string;
  person1_id: string;
  person2_id: string | null;
  status: "married" | "partners" | "divorced" | "widowed" | "unknown";
  married_date: string | null;
  married_place: string | null;
  divorced_date: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

/** `gallery_album_items` */
export interface GalleryAlbumItemRow {
  album_id: string;
  item_id: string;
  position: number;
  added_at: string;
}

/** `gallery_albums` */
export interface GalleryAlbumRow {
  id: string;
  name: string;
  description: string | null;
  cover_item_id: string | null;
  sort_mode: "taken_at" | "manual";
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** `gallery_details` */
export interface GalleryDetailRow {
  item_id: string;
  kind: "photo" | "video" | "audio";
  relative_path: string;
  mime_type: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  orientation: number | null;
  rotation: number;
  duration_seconds: number | null;
  taken_at: string | null;
  taken_at_source: "scan" | "manual";
  modified_at: string | null;
  gps_lat: number | null;
  gps_lng: number | null;
  gps_source: "scan" | "manual";
  taken_precision: "time" | "day" | "month" | "year" | "decade";
  taken_approx: number;
  place_text: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  camera_make: string | null;
  camera_model: string | null;
  preview_storage_key: string | null;
  playable: number | null;
  phash: string | null;
  content_hash: string | null;
  content_hash_at: string | null;
  web_video_key: string | null;
  web_video_attempts: number;
  updated_at: string;
}

/** `gallery_duplicate_contained_ignores` */
export interface GalleryDuplicateContainedIgnoreRow {
  library_id: string;
  folder_path: string;
  target_library_id: string;
  target_folder_path: string;
  created_at: string;
}

/** `gallery_duplicate_folder_ignores` */
export interface GalleryDuplicateFolderIgnoreRow {
  library_a: string;
  path_a: string;
  library_b: string;
  path_b: string;
  created_at: string;
}

/** `gallery_duplicate_folder_overlap_ignores` */
export interface GalleryDuplicateFolderOverlapIgnoreRow {
  library_a: string;
  path_a: string;
  library_b: string;
  path_b: string;
  created_at: string;
}

/** `gallery_duplicate_ignores` */
export interface GalleryDuplicateIgnoreRow {
  item_a: string;
  item_b: string;
  created_at: string;
}

/** `gallery_face_exclusions` */
export interface GalleryFaceExclusionRow {
  item_id: string;
  person_id: string;
  created_at: string;
}

/** `gallery_face_scans` */
export interface GalleryFaceScanRow {
  item_id: string;
  scanned_at: string;
  model: string | null;
  face_count: number;
  status: string;
  attempts: number;
}

/** `gallery_faces` */
export interface GalleryFaceRow {
  id: string;
  item_id: string;
  person_id: string | null;
  box_x: number | null;
  box_y: number | null;
  box_w: number | null;
  box_h: number | null;
  det_score: number | null;
  embedding: Buffer | null;
  embedding_model: string | null;
  assignment: "auto" | "suggested" | "confirmed" | "rejected";
  source: "manual" | "scan";
  thumb_storage_key: string | null;
  created_at: string;
  updated_at: string;
}

/** `gallery_music_tracks` */
export interface GalleryMusicTrackRow {
  id: string;
  title: string;
  artist: string | null;
  builtin: number;
  storage_key: string;
  duration_seconds: number | null;
  uploaded_by: string | null;
  created_at: string;
  item_id: string | null;
}

/** `gallery_people` */
export interface GalleryPersonRow {
  id: string;
  name: string;
  linked_person_id: string | null;
  cover_face_id: string | null;
  cover_item_id: string | null;
  hidden: number;
  curated: number;
  face_count: number;
  centroid: Buffer | null;
  created_at: string;
  updated_at: string;
}

/** `gallery_places` */
export interface GalleryPlaceRow {
  item_id: string;
  place_id: number | null;
  distance_km: number | null;
  lat: number;
  lng: number;
  dataset: string;
}

/** `gallery_slideshow_items` */
export interface GallerySlideshowItemRow {
  slideshow_id: string;
  item_id: string;
  position: number;
  dwell_seconds: number | null;
  added_at: string;
}

/** `gallery_slideshows` */
export interface GallerySlideshowRow {
  id: string;
  name: string;
  source_kind: "manual" | "memory" | "album";
  source_ref: string | null;
  music_track_id: string | null;
  transition: "none" | "crossfade" | "fade" | "slide" | "kenburns" | "dipblack" | "random";
  slide_seconds: number;
  transition_seconds: number;
  title_enabled: number;
  title_text: string | null;
  title_subtitle_mode: "count" | "custom" | "none";
  title_subtitle: string | null;
  title_seconds: number;
  title_background: "black" | "photo" | "blur" | "collage";
  title_photo_item_id: string | null;
  card_font: "classic" | "serif" | "bold" | "script" | "typewriter";
  card_size: "small" | "medium" | "large";
  closing_enabled: number;
  closing_text: string | null;
  closing_lines: string | null;
  closing_seconds: number;
  closing_background: "black" | "photo" | "blur" | "collage";
  closing_photo_item_id: string | null;
  outro_item_id: string | null;
  outro_sound: number;
  cover_item_id: string | null;
  render_status: "draft" | "queued" | "rendering" | "ready" | "failed";
  render_stale: number;
  render_job_id: string | null;
  output_storage_key: string | null;
  output_bytes: number | null;
  rendered_at: string | null;
  render_error: string | null;
  movie_target_library_id: string | null;
  movie_on_conflict: "overwrite" | "keep_both";
  movie_file_stem: string | null;
  movie_save_error: string | null;
  movie_library_id: string | null;
  movie_relative_path: string | null;
  movie_item_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** `gallery_voice_notes` */
export interface GalleryVoiceNoteRow {
  id: string;
  item_id: string;
  audio_item_id: string;
  recorded_by: string | null;
  created_at: string;
}

/** `group_members` */
export interface GroupMemberRow {
  group_id: string;
  user_id: string;
  role: "member" | "manager";
  joined_at: string;
}

/** `inbox_delivery_seen` */
export interface InboxDeliverySeenRow {
  user_id: string;
  library_id: string;
  folder: string;
  seen_at: string;
  dismissed_at: string | null;
}

/** `invites` */
export interface InviteRow {
  id: string;
  token_hash: string;
  role: "admin" | "member";
  created_by: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_by: string | null;
  revoked_at: string | null;
}

/** `ip_reputation` */
export interface IpReputationRow {
  ip_address: string;
  score: number | null;
  total_reports: number | null;
  last_reported_at: string | null;
  country_code: string | null;
  isp: string | null;
  checked_at: string;
}

/** `item_categories` */
export interface ItemCategoryRow {
  item_id: string;
  category_id: string;
  is_primary: 0 | 1;
  source: "scan" | "manual" | "metadata" | "ai";
}

/** `item_metadata` */
export interface ItemMetadataRow {
  item_id: string;
  source: "scan" | "manual";
  title: string | null;
  sort_title: string | null;
  alpha_key: string | null;
  alpha_script: string | null;
  alpha_override: string | null;
  sort_key: string | null;
  description: string | null;
  language: string | null;
  publisher: string | null;
  year_published: number | null;
  isbn: string | null;
  openlibrary_id: string | null;
  cover_storage_key: string | null;
  rating: number | null;
  updated_at: string;
}

/** `item_people` */
export interface ItemPersonRow {
  item_id: string;
  person_id: string;
  role: "author" | "narrator" | "editor" | "artist" | "photographer" | "contributor";
  sort_order: number;
}

/** `item_saves` */
export interface ItemSaveRow {
  id: string;
  user_id: string;
  item_id: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

/** `jobs` */
export interface JobRow {
  id: string;
  type: string;
  payload: string;
  status: "pending" | "running" | "completed" | "failed";
  attempts: number;
  max_attempts: number;
  run_at: string;
  locked_at: string | null;
  locked_by: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  error: string | null;
}

/** `known_login_networks` */
export interface KnownLoginNetworkRow {
  user_id: string;
  network_key: string;
  last_ip: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

/** `libraries` */
export interface LibraryRow {
  id: string;
  name: string;
  type: string;
  source_path: string;
  owner_id: string | null;
  owner_type: "user" | "group" | null;
  policy_json: string;
  settings_json: string;
  scan_status: "idle" | "scanning" | "error";
  last_scanned_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** `library_folder_locks` */
export interface LibraryFolderLockRow {
  library_id: string;
  folder_path: string;
  locked_by: string | null;
  locked_at: string;
}

/** `library_items` */
export interface LibraryItemRow {
  id: string;
  library_id: string;
  type: string;
  folder_path: string;
  status: "pending" | "ready" | "error";
  series_source: "scan" | "manual";
  scan_rule_id: string | null;
  discovered_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** `library_scan_rule_paths` */
export interface LibraryScanRulePathRow {
  rule_id: string;
  library_id: string;
  relative_path: string;
}

/** `library_scan_rules` */
export interface LibraryScanRuleRow {
  id: string;
  library_id: string;
  name: string;
  enabled: number;
  preset: string | null;
  layouts_json: string;
  last_scanned_at: string | null;
  created_at: string;
  updated_at: string;
}

/** `login_attempts` */
export interface LoginAttemptRow {
  id: string;
  email: string | null;
  ip_address: string | null;
  successful: 0 | 1;
  kind: "signin" | "probe" | "token";
  created_at: string;
}

/** `mfa_challenges` */
export interface MfaChallengeRow {
  id: string;
  user_id: string;
  purpose: "login" | "enroll";
  created_at: string;
  expires_at: string;
  attempts: number;
  code_hash: string | null;
  sends: number;
  last_sent_at: string | null;
}

/** `notes` */
export interface NoteRow {
  id: string;
  user_id: string | null;
  author_name: string | null;
  entity_type: string;
  entity_id: string;
  body: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** `people` */
export interface PersonRow {
  id: string;
  name: string;
  sort_name: string | null;
  bio: string | null;
  website: string | null;
  location: string | null;
  birth_date: string | null;
  death_date: string | null;
  country: string | null;
  occupation: string | null;
  image_storage_key: string | null;
  openlibrary_id: string | null;
  wikipedia_url: string | null;
  enriched_at: string | null;
  created_at: string;
}

/** `person_aliases` */
export interface PersonAliasRow {
  id: string;
  alias: string;
  canonical_name: string;
  created_by: string | null;
  created_at: string;
}

/** `playback_progress` */
export interface PlaybackProgressRow {
  id: string;
  user_id: string;
  item_id: string;
  current_file_id: string | null;
  position_seconds: number;
  duration_seconds: number | null;
  percent_complete: number | null;
  updated_at: string;
  completed_at: string | null;
}

/** `quote_imports` */
export interface QuoteImportRow {
  id: string;
  user_id: string;
  file_name: string | null;
  quote_count: number;
  created_at: string;
}

/** `quotes` */
export interface QuoteRow {
  id: string;
  user_id: string;
  item_id: string | null;
  document_id: string | null;
  cfi: string | null;
  text: string;
  note: string | null;
  color: string | null;
  source_title: string | null;
  source_author: string | null;
  percent_complete: number | null;
  origin: "manual" | "reader" | "import";
  visibility: "private" | "family";
  in_rotation: number;
  language: string | null;
  quote_date: string | null;
  context: string | null;
  family_tree_person_id: string | null;
  person_name: string | null;
  import_id: string | null;
  created_at: string;
  updated_at: string;
}

/** `reading_bookmarks` */
export interface ReadingBookmarkRow {
  id: string;
  user_id: string;
  item_id: string;
  document_id: string;
  location: string;
  percent_complete: number | null;
  label: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

/** `reading_progress` */
export interface ReadingProgressRow {
  id: string;
  user_id: string;
  item_id: string;
  document_id: string;
  location: string;
  percent_complete: number | null;
  label: string | null;
  updated_at: string;
  completed_at: string | null;
}

/** `recommendations` */
export interface RecommendationRow {
  id: string;
  from_user_id: string | null;
  to_user_id: string;
  entity_type: string;
  entity_id: string;
  message: string | null;
  status: "new" | "saved" | "dismissed";
  subject_title: string | null;
  from_name: string | null;
  created_at: string;
  seen_at: string | null;
  ask_notes: number;
}

/** `scheduled_jobs` */
export interface ScheduledJobRow {
  key: string;
  enabled: number;
  frequency: "daily" | "weekly" | "monthly";
  run_time: string | null;
  day_of_week: number | null;
  day_of_month: number | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: "success" | "error" | null;
  last_message: string | null;
  updated_at: string;
}

/** `series` */
export interface SeriesRow {
  id: string;
  library_id: string;
  name: string;
  sort_name: string | null;
  description: string | null;
  cover_storage_key: string | null;
  created_at: string;
}

/** `series_items` */
export interface SeriesItemRow {
  series_id: string;
  item_id: string;
  position: number | null;
  source: "scan" | "manual";
}

/** `sessions` */
export interface SessionRow {
  id: string;
  token_hash: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  device_name: string | null;
  ip_address: string | null;
  kind: "browser" | "device";
  label: string | null;
  revoked_at: string | null;
}

/** `share_link_drops` */
export interface ShareLinkDropRow {
  id: string;
  share_link_id: string;
  item_id: string | null;
  file_name: string;
  size_bytes: number;
  created_at: string;
}

/** `share_link_items` */
export interface ShareLinkItemRow {
  id: string;
  share_link_id: string;
  item_id: string;
  position: number;
}

/** `share_links` */
export interface ShareLinkRow {
  id: string;
  module: string;
  resource_id: string;
  token_hash: string;
  permission: "read" | "edit" | "manage";
  label: string | null;
  expires_at: string;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
  max_files: number | null;
  max_bytes: number | null;
  one_time: number;
  expand_albums: number;
}

/** `shares` */
export interface ShareRow {
  id: string;
  module: string;
  resource_id: string;
  user_id: string;
  permission: "read" | "edit" | "manage";
  created_by: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

/** `storage_roots` */
export interface StorageRootRow {
  id: string;
  name: string;
  path: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** `stories` */
export interface StoryRow {
  id: string;
  title: string;
  subtitle: string | null;
  cover_item_id: string | null;
  status: string;
  chapter_noun: string | null;
  intro: string | null;
  rating: number | null;
  servings: string | null;
  cook_minutes: number | null;
  author_name: string | null;
  kind: string;
  collection_id: string | null;
  deleted_at: string | null;
  purge_after: string | null;
  published_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** `story_audio` */
export interface StoryAudioRow {
  id: string;
  story_id: string;
  storage_key: string;
  title: string | null;
  duration_seconds: number | null;
  uploaded_by: string | null;
  created_at: string;
}

/** `story_block_points` */
export interface StoryBlockPointRow {
  id: string;
  block_id: string;
  position: number;
  lat: number;
  lng: number;
  label: string | null;
  mode: string | null;
  geometry: string | null;
}

/** `story_blocks` */
export interface StoryBlockRow {
  id: string;
  chapter_id: string;
  position: number;
  kind: string;
  entity_type: string | null;
  entity_id: string | null;
  body: string | null;
  heading: string | null;
  lat: number | null;
  lng: number | null;
  zoom: number | null;
  label: string | null;
  caption: string | null;
  layout: string | null;
}

/** `story_chapters` */
export interface StoryChapterRow {
  id: string;
  story_id: string;
  position: number;
  title: string | null;
  date: string | null;
  end_date: string | null;
  date_approx: number;
  place: string | null;
  place_lat: number | null;
  place_lng: number | null;
  description: string | null;
  standfirst: string | null;
  hero_item_id: string | null;
  hero_map: number;
}

/** `story_collections` */
export interface StoryCollectionRow {
  id: string;
  title: string;
  description: string | null;
  cover_item_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** `story_saves` */
export interface StorySaveRow {
  story_id: string;
  user_id: string;
  created_at: string;
}

/** `story_updates` */
export interface StoryUpdateRow {
  id: string;
  story_id: string;
  chapter_id: string;
  actor_id: string | null;
  created_at: string;
}

/** `taggables` */
export interface TaggableRow {
  tag_id: string;
  entity_type: string;
  entity_id: string;
}

/** `tags` */
export interface TagRow {
  id: string;
  key: string;
  display_name: string;
  created_at: string;
}

/** `track_progress` */
export interface TrackProgressRow {
  id: string;
  user_id: string;
  item_id: string;
  file_id: string;
  position_seconds: number;
  duration_seconds: number | null;
  completed_at: string | null;
  updated_at: string;
}

/** `trashed_items` */
export interface TrashedItemRow {
  id: string;
  library_id: string;
  library_type: string;
  library_name: string;
  source_path: string;
  title: string;
  origin_path: string;
  trash_path: string;
  file_count: number;
  size_bytes: number;
  cover_key: string | null;
  source: string;
  expires_at: string | null;
  trash_root: string | null;
  trashed_by: string | null;
  trashed_at: string;
}

/** `trusted_networks` */
export interface TrustedNetworkRow {
  id: string;
  cidr: string;
  label: string | null;
  created_at: string;
  created_by: string | null;
}

/** `user_groups` */
export interface UserGroupRow {
  id: string;
  name: string;
  kind: "normal" | "system";
  created_by: string;
  created_at: string;
}

/** `user_seen_versions` */
export interface UserSeenVersionRow {
  user_id: string;
  version: string;
  updated_at: string;
}

/** `users` */
export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  role: "admin" | "member";
  theme: string;
  language: string;
  protected_from_delete: 0 | 1;
  is_active: 0 | 1;
  ereader_email: string | null;
  mfa_enabled: number;
  mfa_method: "totp" | "email";
  mfa_secret: string | null;
  mfa_backup_codes: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** `webauthn_challenges` */
export interface WebauthnChallengeRow {
  id: string;
  user_id: string | null;
  purpose: "login" | "register";
  challenge: string;
  created_at: string;
  expires_at: string;
}

/** `webauthn_credentials` */
export interface WebauthnCredentialRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  backed_up: 0 | 1;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  last_ip: string | null;
}

/** `work_items` */
export interface WorkItemRow {
  work_id: string;
  item_id: string;
  is_primary: 0 | 1;
  added_at: string;
}

/** `works` */
export interface WorkRow {
  id: string;
  created_by: string | null;
  created_at: string;
}

/** Every table's row type, by table name. */
export interface TableRows {
  activity_logs: ActivityLogRow;
  api_tokens: ApiTokenRow;
  app_settings: AppSettingRow;
  assignments: AssignmentRow;
  audio_bookmarks: AudioBookmarkRow;
  audio_chapters: AudioChapterRow;
  audio_files: AudioFileRow;
  audiobook_details: AudiobookDetailRow;
  blocked_ips: BlockedIpRow;
  categories: CategoryRow;
  category_aliases: CategoryAliasRow;
  collection_items: CollectionItemRow;
  collections: CollectionRow;
  device_link_requests: DeviceLinkRequestRow;
  device_link_windows: DeviceLinkWindowRow;
  document_files: DocumentFileRow;
  duplicate_job_actions: DuplicateJobActionRow;
  duplicate_job_errors: DuplicateJobErrorRow;
  duplicate_job_folder_preferences: DuplicateJobFolderPreferenceRow;
  duplicate_job_libraries: DuplicateJobLibraryRow;
  duplicate_job_result_folders: DuplicateJobResultFolderRow;
  duplicate_job_result_members: DuplicateJobResultMemberRow;
  duplicate_job_results: DuplicateJobResultRow;
  duplicate_jobs: DuplicateJobRow;
  ebook_details: EbookDetailRow;
  family_tree_children: FamilyTreeChildRow;
  family_tree_citations: FamilyTreeCitationRow;
  family_tree_event_photos: FamilyTreeEventPhotoRow;
  family_tree_events: FamilyTreeEventRow;
  family_tree_persons: FamilyTreePersonRow;
  family_tree_photos: FamilyTreePhotoRow;
  family_tree_sources: FamilyTreeSourceRow;
  family_tree_unions: FamilyTreeUnionRow;
  gallery_album_items: GalleryAlbumItemRow;
  gallery_albums: GalleryAlbumRow;
  gallery_details: GalleryDetailRow;
  gallery_duplicate_contained_ignores: GalleryDuplicateContainedIgnoreRow;
  gallery_duplicate_folder_ignores: GalleryDuplicateFolderIgnoreRow;
  gallery_duplicate_folder_overlap_ignores: GalleryDuplicateFolderOverlapIgnoreRow;
  gallery_duplicate_ignores: GalleryDuplicateIgnoreRow;
  gallery_face_exclusions: GalleryFaceExclusionRow;
  gallery_face_scans: GalleryFaceScanRow;
  gallery_faces: GalleryFaceRow;
  gallery_music_tracks: GalleryMusicTrackRow;
  gallery_people: GalleryPersonRow;
  gallery_places: GalleryPlaceRow;
  gallery_slideshow_items: GallerySlideshowItemRow;
  gallery_slideshows: GallerySlideshowRow;
  gallery_voice_notes: GalleryVoiceNoteRow;
  group_members: GroupMemberRow;
  inbox_delivery_seen: InboxDeliverySeenRow;
  invites: InviteRow;
  ip_reputation: IpReputationRow;
  item_categories: ItemCategoryRow;
  item_metadata: ItemMetadataRow;
  item_people: ItemPersonRow;
  item_saves: ItemSaveRow;
  jobs: JobRow;
  known_login_networks: KnownLoginNetworkRow;
  libraries: LibraryRow;
  library_folder_locks: LibraryFolderLockRow;
  library_items: LibraryItemRow;
  library_scan_rule_paths: LibraryScanRulePathRow;
  library_scan_rules: LibraryScanRuleRow;
  login_attempts: LoginAttemptRow;
  mfa_challenges: MfaChallengeRow;
  notes: NoteRow;
  people: PersonRow;
  person_aliases: PersonAliasRow;
  playback_progress: PlaybackProgressRow;
  quote_imports: QuoteImportRow;
  quotes: QuoteRow;
  reading_bookmarks: ReadingBookmarkRow;
  reading_progress: ReadingProgressRow;
  recommendations: RecommendationRow;
  scheduled_jobs: ScheduledJobRow;
  series: SeriesRow;
  series_items: SeriesItemRow;
  sessions: SessionRow;
  share_link_drops: ShareLinkDropRow;
  share_link_items: ShareLinkItemRow;
  share_links: ShareLinkRow;
  shares: ShareRow;
  storage_roots: StorageRootRow;
  stories: StoryRow;
  story_audio: StoryAudioRow;
  story_block_points: StoryBlockPointRow;
  story_blocks: StoryBlockRow;
  story_chapters: StoryChapterRow;
  story_collections: StoryCollectionRow;
  story_saves: StorySaveRow;
  story_updates: StoryUpdateRow;
  taggables: TaggableRow;
  tags: TagRow;
  track_progress: TrackProgressRow;
  trashed_items: TrashedItemRow;
  trusted_networks: TrustedNetworkRow;
  user_groups: UserGroupRow;
  user_seen_versions: UserSeenVersionRow;
  users: UserRow;
  webauthn_challenges: WebauthnChallengeRow;
  webauthn_credentials: WebauthnCredentialRow;
  work_items: WorkItemRow;
  works: WorkRow;
}
