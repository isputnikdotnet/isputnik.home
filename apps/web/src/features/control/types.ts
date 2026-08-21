import type { PublicUser } from "../../api";

export interface ManagedUser extends PublicUser {
  activeSessions: number;
  locked: boolean;
  /** How many passkeys the account has registered. Zero disables the clear action —
   *  there is nothing to rescue them from. */
  passkeyCount: number;
  /** When this person's permission to link a device from outside the home network
   *  runs out, or null — which is almost always, and is the point. */
  deviceLinkWindowExpiresAt: string | null;
}

export interface ManagedInvite {
  id: string;
  url: string | null;
  role: "admin" | "member";
  status: "active" | "expired" | "used";
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  createdByName: string;
  usedByName: string | null;
}

/** A linked display, or the best guess at what a browser session is running on. */
export type DeviceType = "display" | "phone" | "tablet" | "computer" | "unknown";

export interface ManagedSession {
  id: string;
  userId: string;
  displayName: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  lastSeen: string;
  kind: "browser" | "device";
  /** The owner's own name for the device, when they have given one. */
  label: string | null;
  /** What to put on the row: `label`, or the description derived from the agent. */
  name: string;
  /** That derived description on its own, so a renamed device still says what it is. */
  agent: string;
  type: DeviceType;
  deviceName: string | null;
  ipAddress: string | null;
  current: boolean;
}

export interface LogEvent {
  id: string;
  event: string;
  detail: string;
  ipAddress: string | null;
  createdAt: string;
  actorName: string | null;
}

export interface LibraryStatusStats {
  id: string;
  name: string;
  bookCount: number;
  totalSizeBytes: number;
  totalDurationSeconds: number;
}

export interface PersonStatusStats {
  name: string;
  bookCount: number;
  totalDurationSeconds: number;
}

export interface BookDurationStats {
  id: string;
  title: string;
  libraryName: string;
  authors: string[];
  totalSizeBytes: number;
  totalDurationSeconds: number;
}

export interface EbookLibraryStatusStats {
  id: string;
  name: string;
  bookCount: number;
  totalSizeBytes: number;
}

export interface EbookPersonStatusStats {
  name: string;
  bookCount: number;
}

export interface FormatStats {
  format: string;
  count: number;
}

export interface EbookSizeStats {
  id: string;
  title: string;
  libraryName: string;
  authors: string[];
  formats: string[];
  totalSizeBytes: number;
}

export interface EbookStats {
  totalLibraries: number;
  totalBooks: number;
  totalSizeBytes: number;
  libraries: EbookLibraryStatusStats[];
  topAuthors: EbookPersonStatusStats[];
  formats: FormatStats[];
  largestBooks: EbookSizeStats[];
}

export interface GalleryLibraryStatusStats {
  id: string;
  name: string;
  itemCount: number;
  photoCount: number;
  videoCount: number;
  totalSizeBytes: number;
  totalDurationSeconds: number;
}

export interface GallerySizeStats {
  id: string;
  title: string;
  libraryName: string;
  kind: string;
  totalSizeBytes: number;
  durationSeconds: number;
}

export interface GalleryStats {
  totalLibraries: number;
  totalItems: number;
  totalPhotos: number;
  totalVideos: number;
  totalSizeBytes: number;
  totalDurationSeconds: number;
  libraries: GalleryLibraryStatusStats[];
  largestItems: GallerySizeStats[];
}

export interface SystemStatus {
  health: string;
  databaseBytes: number;
  users: number;
  activeSessions: number;
  activeInvites: number;
  logEntries: number;
  audiobookLibraries: number;
  audiobookBooks: number;
  libraryStats: {
    totalLibraries: number;
    totalBooks: number;
    totalSizeBytes: number;
    totalDurationSeconds: number;
    libraries: LibraryStatusStats[];
    topAuthors: PersonStatusStats[];
    topNarrators: PersonStatusStats[];
    longestBooks: BookDurationStats[];
  };
  ebookStats: EbookStats;
  galleryStats: GalleryStats;
  uptimeSeconds: number;
  generatedAt: string;
}

export interface LibrarySettings {
  thumbnailPath: string;
  thumbnailPathReady: boolean;
  thumbnailPathError: string;
  fromEnvironment: boolean;
}

export interface StorageRoot {
  id: string;
  name: string;
  path: string;
  createdAt?: string;
  updatedAt?: string;
  libraryCount: number;
}

export interface StorageBrowseEntry {
  name: string;
  relativePath: string;
}

export interface StorageBrowse {
  root: StorageRoot;
  currentPath: string;
  selectedPath: string;
  parentPath: string | null;
  entries: StorageBrowseEntry[];
}

export interface Job {
  id: string;
  type: string;
  status: "pending" | "running" | "completed" | "failed";
  attempts: number;
  libraryName: string | null;
  createdAt: string;
  // When the worker began running the job (null until claimed). Duration is measured
  // from here, not createdAt, so time spent queued isn't counted.
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  error: string | null;
  // Human-readable result line for finished tasks, built server-side per job type.
  summary: string | null;
  // Live progress, present only while running; unit names what's counted ("books", "photos").
  progress: {
    processed: number;
    total: number;
    unit: string;
    etaSeconds: number | null;
  } | null;
  // Position within a pre-queued batch group ("batch 2 of 5"); null for single jobs.
  batch: { index: number; total: number } | null;
  bookErrors: string[];
}

export interface DbInfo {
  path: string;
  directory: string;
  filename: string;
  sizeBytes: number;
  walSizeBytes: number;
  totalSizeBytes: number;
  lastModified: string | null;
}

export interface DashboardSeries {
  loginsSuccess: number[];
  loginsFailed: number[];
  uploads: number[];
  downloads: number[];
  deletes: number[];
  played: number[];
  read: number[];
  viewed: number[];
}

export interface DashboardSummary {
  days: string[];
  series: DashboardSeries;
  kpis: { logins24h: number; uploads7d: number; downloads7d: number; deletes7d: number };
}

// /api/dashboard/activity — the Activity tab's range-scoped payload, shaped like
// DashboardLogins so the two tabs' date toolbars drive identical machinery.
export type ActivityKey = "uploads" | "downloads" | "deletes" | "played" | "read" | "viewed";

export interface DashboardActivity {
  from: string;
  to: string;
  bucket: "hour" | "day";
  buckets: string[];
  series: Record<ActivityKey, number[]>;
  totals: Record<ActivityKey, number>;
  /** The equal-length window immediately before this one. */
  previous: Record<ActivityKey, number>;
}

// /api/dashboard/logins — the Logins view's range-scoped payload. `buckets` are
// ISO instants (hourly or daily, per `bucket`) aligned with each series array.
export interface DashboardLogins {
  from: string;
  to: string;
  bucket: "hour" | "day";
  buckets: string[];
  series: { success: number[]; failed: number[] };
  methods: { password: number; passkey: number; twoFactor: number; deviceLink: number };
  totals: { attempts: number; success: number; failed: number; people: number; blockedIps: number };
  /** The equal-length window immediately before this one, for the change badges. */
  previous: { attempts: number; success: number; failed: number; blockedIps: number };
}

// Cached AbuseIPDB reputation for one address (/api/security/ip-reputation).
export interface IpReputationEntry {
  ip: string;
  score: number | null;
  totalReports: number | null;
  lastReportedAt: string | null;
  countryCode: string | null;
  isp: string | null;
  checkedAt: string;
}

// /api/dashboard/locations — sign-ins in a window, grouped by the country their
// address resolves to against the local DB-IP database.
export interface GeoipStatus {
  available: boolean;
  /** "city" only when the owner has supplied a city-level database themselves. */
  tier: "city" | "country" | null;
  databaseType: string | null;
  buildDate: string | null;
  updatedAt: string | null;
  sizeBytes: number | null;
  /** Where to drop a database by hand. */
  directory: string;
  databases: { file: string; name: string; tier: "city" | "country"; databaseType: string; buildDate: string | null; sizeBytes: number; updatedAt: string }[];
  countryFilePresent: boolean;
  source: string;
}

/** Where the household says it lives — used only to draw its own dot. */
export interface HomeLocation {
  latitude: number;
  longitude: number;
  label: string;
}

export interface DashboardLocations {
  from: string;
  to: string;
  geoip: GeoipStatus;
  home: HomeLocation | null;
  total: number;
  local: { connections: number; failed: number; addresses: number };
  unknown: { connections: number; failed: number; addresses: number };
  countries: { code: string; name: string | null; connections: number; failed: number; addresses: number }[];
  /** Empty unless a city database is in use. */
  places: {
    code: string;
    country: string | null;
    city: string | null;
    region: string | null;
    latitude: number | null;
    longitude: number | null;
    connections: number;
    failed: number;
    addresses: number;
  }[];
}

// /api/dashboard/signins — the Sign-in details drill-down. One payload carries
// every panel of the page, all describing the same scope over the same window.
export interface SignInsScope {
  kind: "all" | "country" | "place" | "ip" | "user";
  label: string;
  code?: string;
  region?: string | null;
  city?: string | null;
  ip?: string;
  userId?: string;
  email?: string;
}

export interface SignInsMethodCounts {
  password: number;
  passkey: number;
  twoFactor: number;
  deviceLink: number;
}

export interface SignInsIpRow {
  ip: string;
  connections: number;
  failed: number;
  people: number;
  lastSeen: string;
  local: boolean;
  location: string | null;
  code: string | null;
  blocked: { auto: boolean; expiresAt: string | null; lapsed: boolean } | null;
  probes: number;
  tokens: number;
}

export interface SignInsUserRow {
  userId: string | null;
  name: string | null;
  email: string | null;
  connections: number;
  failed: number;
  addresses: number;
  lastSeen: string;
  methods: SignInsMethodCounts;
}

export interface SignInsDeviceRow {
  id: string;
  name: string;
  agent: string;
  type: DeviceType;
  person: string;
  personId: string;
  ip: string | null;
  lastSeen: string;
  expiresAt: string;
  /** The session making this request — pinned first, and never revocable here. */
  current: boolean;
}

export interface SignInsEventRow {
  id: string;
  event: string;
  detail: string;
  ip: string | null;
  at: string;
  actor: string | null;
  failed: boolean;
}

export interface DashboardSignIns {
  from: string;
  to: string;
  scope: SignInsScope;
  truncated: boolean;
  totals: {
    attempts: number;
    success: number;
    failed: number;
    people: number;
    addresses: number;
    firstSeen: string | null;
    lastSeen: string | null;
  };
  methods: SignInsMethodCounts;
  series: { bucket: "hour" | "day"; buckets: string[]; success: number[]; failed: number[] };
  ips: SignInsIpRow[];
  users: SignInsUserRow[];
  devices: SignInsDeviceRow[];
  guessedNames: { email: string; attempts: number; lastSeen: string }[];
  events: SignInsEventRow[];
}

export interface DashboardInProgressEntry {
  kind: "audiobook" | "ebook";
  updatedAt: string;
  percentComplete: number | null;
  userName: string;
  title: string;
}

export interface ManagedGroup {
  id: string;
  name: string;
  createdAt: string;
  memberCount: number;
  libraryCount: number;
}

export interface GroupMember {
  userId: string;
  displayName: string;
  email: string;
  joinedAt: string;
}
