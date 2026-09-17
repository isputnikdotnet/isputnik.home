import {
  BookOpen, BookText, FolderTree, HardDrive, Headphones, Images, Inbox, KeyRound, LibraryBig, Mail, MonitorSmartphone,
  Quote, Rocket, Send, Settings, ShieldCheck, Trash2, UserRound, Wifi, type LucideIcon
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
  }
} satisfies Record<string, GuideEntry>;

export type GuideKey = keyof typeof GUIDES;

export const guideHref = (key: GuideKey) => `/help/${GUIDES[key].slug}`;
export const GUIDES_INDEX_PATH = "/help/guides";

// A topic of one guide opens that guide; a topic of several opens its section of
// the guide list, rather than guessing which of them was meant.
export const topicHref = (topic: HelpTopic) =>
  topic.guides.length === 1 ? guideHref(topic.guides[0]) : `${GUIDES_INDEX_PATH}#${topic.id}`;
export const guideVisible = (key: GuideKey, isAdmin: boolean) => isAdmin || !(GUIDES[key] as GuideEntry).adminOnly;

export interface HelpTopic {
  /** Also the section anchor on /help/guides. */
  id: string;
  icon: LucideIcon;
  title: string;
  summary: string;
  guides: GuideKey[];
  /** Marked as admin-only where it's listed. */
  adminOnly?: boolean;
}

export interface QuickStartTile {
  guide: GuideKey;
  icon: LucideIcon;
  title: string;
  summary: string;
}

// Eight topics, two columns of four, for either audience. An admin's eighth is the
// server; a member can't open the control panel, so theirs is Quotes — which an
// admin finds under Stories instead. Every guide belongs to exactly one topic for
// a given audience (pinned by test/helpCatalog.test.ts), so /help/guides lists
// each once.
export function helpTopics(isAdmin: boolean): HelpTopic[] {
  const topics: HelpTopic[] = [
    { id: "audiobooks", icon: Headphones, title: "Audiobooks", summary: "Chapters, playback and where your place is kept", guides: ["audiobooks"] },
    { id: "ebooks", icon: BookOpen, title: "Ebooks", summary: "EPUB, PDF, the reader and multi-format books", guides: ["ebooks"] },
    {
      id: "gallery",
      icon: Images,
      title: "Gallery",
      summary: isAdmin ? "Photos, albums, faces, the Photo Inbox and duplicates" : "Photos, albums, faces and the Photo Inbox",
      guides: ["gallery", "photoInbox", "duplicateCleanup"]
    },
    { id: "family-tree", icon: FolderTree, title: "Family tree", summary: "People, events, photos and the map", guides: ["familyTree"] },
    {
      id: "stories",
      icon: BookText,
      title: "Stories",
      summary: isAdmin ? "Chapters, narration, quotes and guest links" : "Chapters, narration and guest links",
      guides: isAdmin ? ["stories", "quotes"] : ["stories"]
    },
    { id: "account", icon: UserRound, title: "Your account", summary: "Profile, themes, sharing and your e-reader", guides: ["yourAccount", "familySharing"] },
    { id: "security", icon: ShieldCheck, title: "Sign-in & security", summary: "Passkeys, two-factor and linked devices", guides: ["passkeys", "twoFactor", "linkDevice"] },
    isAdmin
      ? {
          id: "server",
          icon: Settings,
          title: "Control panel",
          summary: "Storage, libraries, email, and opening up to the internet",
          guides: ["firstRun", "storage", "libraries", "controlPanel", "email", "internet"],
          adminOnly: true
        }
      : { id: "quotes", icon: Quote, title: "Quotes", summary: "Highlights, family sayings and the quote of the day", guides: ["quotes"] }
  ];
  return topics
    .map((topic) => ({ ...topic, guides: topic.guides.filter((key) => guideVisible(key, isAdmin)) }))
    .filter((topic) => topic.guides.length > 0);
}

export function quickStart(isAdmin: boolean): QuickStartTile[] {
  const shared: QuickStartTile[] = [
    { guide: "familySharing", icon: Send, title: "Sharing with family", summary: "Pass things on, or make a guest link" },
    { guide: "stories", icon: BookText, title: "Create a story", summary: "Add chapters, photos and places" }
  ];
  return isAdmin
    ? [
        { guide: "firstRun", icon: Rocket, title: "First run", summary: "Sign in, set up and invite family" },
        { guide: "libraries", icon: LibraryBig, title: "Setting up libraries", summary: "Add folders and scan media" },
        ...shared
      ]
    : [
        { guide: "yourAccount", icon: UserRound, title: "Your account", summary: "Profile, themes and sign-in" },
        { guide: "gallery", icon: Images, title: "The gallery", summary: "Timeline, albums and faces" },
        ...shared
      ];
}

/** The guides this person can open, for search. */
export function visibleGuides(isAdmin: boolean): GuideEntry[] {
  return (Object.keys(GUIDES) as GuideKey[]).filter((key) => guideVisible(key, isAdmin)).map((key) => GUIDES[key]);
}
