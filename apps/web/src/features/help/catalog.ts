import {
  BookOpen, BookText, Boxes, FolderTree, HardDrive, Headphones, Images, Inbox, KeyRound, LibraryBig, Link2, Mail, MonitorSmartphone,
  Quote, Rocket, Send, Settings, ShieldCheck, Smartphone, Trash2, Tv, UserRound, Wifi, type LucideIcon
} from "lucide-react";

// Every user guide the app can open, and how the Help pages arrange them.
//
// The guides live in docs/users/ (see docs/users/README.md), so this list has to
// stay in step with that folder — `check:ui` reads the guide(…) calls below
// and fails when a guide on disk isn't listed, or a listed one doesn't exist. The
// file name is kept as the argument (not the slug) for that reason.
//
// The text here stays English on purpose, like the guides it describes; only the
// pages' own chrome is translated.
const guide = (file: string) => file.replace(/\.md$/, "");

export interface GuideEntry {
  slug: string;
  icon: LucideIcon;
  title: string;
  description: string;
  /** Setup and server guides describe the control panel, which members can't open. */
  adminOnly?: boolean;
  /** Short facts shown as chips under the guide's title ("Android & iPhone"). */
  meta?: string[];
  /** The guide's steps in a few words, for the featured card on the Help page. */
  steps?: string[];
  /** A diagram from docs/users/images/diagrams/, shown on the featured card. */
  diagram?: string;
}

export const GUIDES = {
  firstRun: {
    slug: guide("first-run.md"),
    icon: Rocket,
    title: "First run",
    description: "Creating the setup admin, signing in, and inviting the rest of the family.",
    adminOnly: true
  },
  storage: {
    slug: guide("storage.md"),
    icon: HardDrive,
    title: "Storage",
    description: "The two things every install needs: somewhere for generated thumbnails, and the folders libraries may read.",
    adminOnly: true
  },
  libraries: {
    slug: guide("libraries.md"),
    icon: LibraryBig,
    title: "Setting up libraries",
    description: "The Add-library wizard, pointing a library at a folder, and what the first scan does.",
    adminOnly: true
  },
  audiobooks: {
    slug: guide("library-audiobooks.md"),
    icon: Headphones,
    title: "Audiobooks",
    description: "How folders become books with chapters, and where your place is kept."
  },
  ebooks: {
    slug: guide("library-ebooks.md"),
    icon: BookOpen,
    title: "Ebooks",
    description: "EPUB and PDF, the in-app reader, and books that come in more than one format."
  },
  gallery: {
    slug: guide("library-gallery.md"),
    icon: Images,
    title: "Gallery",
    description: "Photos and videos, the timeline, albums, slideshows, and face recognition."
  },
  photoInbox: {
    slug: guide("photo-inbox.md"),
    icon: Inbox,
    title: "Photo Inbox",
    description: "Re-scanning prints and taking photos from relatives: the holding library, the copy check, Keep and Replace, and drop links."
  },
  phoneBackup: {
    slug: guide("phone-backup.md"),
    icon: Smartphone,
    title: "Backing up your phone",
    description: "Your phone's photos into your own private library with PhotoSync: who can see them, adding a phone, automatic backups on Android and iPhone, and whether it is working.",
    meta: ["Android & iPhone", "About 10 minutes"],
    steps: ["Turn on My library", "Add a phone", "Set up PhotoSync", "Let it back up on its own"],
    diagram: "images/diagrams/phone-backup-mini.svg"
  },
  phoneBackupLinking: {
    slug: guide("phone-backup-linking.md"),
    icon: Link2,
    title: "Linking a phone to a library",
    description: "When a phone's photos already reach the server another way (Immich, say): linking it so nothing is stored twice, and what deleting does.",
    meta: ["Before the first backup"]
  },
  phoneSyncSetup: {
    slug: guide("phone-sync-setup.md"),
    icon: Wifi,
    title: "Setting up phone backups",
    description: "Allowing personal libraries, the networks phones may back up from, the address phones use, VPNs, and what you see of each member's phones.",
    adminOnly: true,
    meta: ["Three settings", "Once per install"]
  },
  duplicateCleanup: {
    slug: guide("duplicate-cleanup.md"),
    icon: Trash2,
    title: "Duplicate cleanup",
    description: "Clearing out copied photos and folders, a saved job at a time — and what stops a delete going wrong.",
    adminOnly: true
  },
  familyTree: {
    slug: guide("family-tree.md"),
    icon: FolderTree,
    title: "Family tree",
    description: "Adding relatives, life events and photos, and letting someone edit their own branch."
  },
  stories: {
    slug: guide("stories.md"),
    icon: BookText,
    title: "Stories",
    description: "Writing a page from what the house already holds — chapters and their pages, narration, collections with their own access, reviews, and guest links."
  },
  quotes: {
    slug: guide("quotes.md"),
    icon: Quote,
    title: "Quotes",
    description: "Passages you highlight while reading, famous lines, and the things your family says — plus the quote of the day, categories, and importing a pack."
  },
  yourAccount: {
    slug: guide("your-account.md"),
    icon: UserRound,
    title: "Your account",
    description: "Your name and sign-in email, themes, the e-reader address, and where likes, bookmarks, quotes and collections live."
  },
  familySharing: {
    slug: guide("family-sharing.md"),
    icon: Send,
    title: "Sharing with family",
    description: "One Send to button for everything — pass a book to someone, mail it to your own e-reader, or make a guest link — plus notes, and where the things people send you land."
  },
  passkeys: {
    slug: guide("passkeys.md"),
    icon: KeyRound,
    title: "Passkeys",
    description: "Sign in with a fingerprint, face or PIN instead of a password — and why no one-time code is needed."
  },
  twoFactor: {
    slug: guide("two-factor-authentication.md"),
    icon: ShieldCheck,
    title: "Two-factor authentication",
    description: "Add a one-time code to your sign-in, manage backup codes, and what to do if you're locked out."
  },
  linkDevice: {
    slug: guide("link-a-device.md"),
    icon: MonitorSmartphone,
    title: "Link a device",
    description: "Sign a TV, wall display or kiosk in by scanning a code with your phone — and how to remove one later."
  },
  tvApp: {
    slug: guide("tv-app.md"),
    icon: Tv,
    title: "The TV app",
    description: "iSputnik TV on an Android TV or Fire TV: installing it, signing in with your phone, several people on one TV, and updates."
  },
  stremio: {
    slug: guide("stremio.md"),
    icon: Tv,
    title: "Watching in Stremio",
    description: "Your own add-on link for the Stremio player on a TV, phone or computer: installing it, the converted stream, subtitles, and revoking a link."
  },
  controlPanel: {
    slug: guide("control-panel.md"),
    icon: Settings,
    title: "The control panel",
    description: "A tour of every section: status, backups, security, labels, logs, scheduled jobs, and accounts.",
    adminOnly: true
  },
  email: {
    slug: guide("email.md"),
    icon: Mail,
    title: "Setting up email",
    description: "The SMTP settings, what the server sends, and why a save-and-test usually fails the first time.",
    adminOnly: true
  },
  internet: {
    slug: guide("exposing-to-the-internet.md"),
    icon: Wifi,
    title: "Exposing your library to the internet",
    description: "Putting it behind HTTPS, the settings to turn on first, and the risks to weigh.",
    adminOnly: true
  },
  apps: {
    slug: guide("apps.md"),
    icon: Boxes,
    title: "Adding the games and video apps",
    description: "Installing the games and video containers, pairing them on Settings → Apps, and choosing who may use them and from where.",
    adminOnly: true
  }
} satisfies Record<string, GuideEntry>;

export type GuideKey = keyof typeof GUIDES;

export const guideHref = (key: GuideKey) => `/help/${GUIDES[key].slug}`;
export const GUIDES_INDEX_PATH = "/help/guides";

export const guideVisible = (key: GuideKey, isAdmin: boolean) => isAdmin || !(GUIDES[key] as GuideEntry).adminOnly;

/** The guide the Help page puts first — the newest thing worth setting up. */
export const FEATURED_GUIDE: { guide: GuideKey; badge: string } = { guide: "phoneBackup", badge: "New in 4.71" };

export interface HelpShelf {
  /** Also the section anchor on /help/guides. */
  id: string;
  icon: LucideIcon;
  title: string;
  guides: GuideKey[];
  /** Marked as admin-only where it's listed. */
  adminOnly?: boolean;
}

// The guides on shelves grouped like the app. Every guide sits on exactly one
// shelf (pinned by test/helpCatalog.test.ts), so /help/guides and the guide rail
// list each once; a member's shelves leave out what they can't open.
const SHELVES: HelpShelf[] = [
  { id: "photos", icon: Images, title: "Photos", guides: ["gallery", "phoneBackup", "phoneBackupLinking", "photoInbox", "duplicateCleanup"] },
  { id: "books", icon: BookOpen, title: "Books", guides: ["audiobooks", "ebooks", "quotes"] },
  { id: "family", icon: FolderTree, title: "Family", guides: ["familyTree", "stories", "familySharing"] },
  { id: "account", icon: KeyRound, title: "You & sign-in", guides: ["yourAccount", "passkeys", "twoFactor", "linkDevice"] },
  { id: "watching", icon: Tv, title: "On the TV", guides: ["tvApp", "stremio"] },
  {
    id: "server",
    icon: Settings,
    title: "Running the server",
    guides: ["firstRun", "storage", "libraries", "phoneSyncSetup", "controlPanel", "email", "internet", "apps"],
    adminOnly: true
  }
];

export function helpShelves(isAdmin: boolean): HelpShelf[] {
  return SHELVES.map((shelf) => ({ ...shelf, guides: shelf.guides.filter((key) => guideVisible(key, isAdmin)) })).filter(
    (shelf) => shelf.guides.length > 0
  );
}

/** The shelf a guide sits on, found by its slug. */
export function shelfOf(slug: string): HelpShelf | undefined {
  return SHELVES.find((shelf) => shelf.guides.some((key) => GUIDES[key].slug === slug));
}

/** The catalog entry for a slug, if the guide is listed. */
export function guideBySlug(slug: string): GuideEntry | undefined {
  return (Object.values(GUIDES) as GuideEntry[]).find((entry) => entry.slug === slug);
}

/** The guides this person can open, for search. */
export function visibleGuides(isAdmin: boolean): GuideEntry[] {
  return (Object.keys(GUIDES) as GuideKey[]).filter((key) => guideVisible(key, isAdmin)).map((key) => GUIDES[key]);
}
