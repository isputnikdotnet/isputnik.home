import { BookOpen, BookText, Bug, ExternalLink, FileCog, FolderTree, HardDrive, Headphones, Images, Info, KeyRound, LibraryBig, Mail, MonitorSmartphone, Quote, Rocket, Send, Settings, ShieldCheck, Trash2, UserRound, Wifi, type LucideIcon } from "lucide-react";
import type { PublicUser } from "../api";
import { DashboardShell } from "../app/DashboardShell";
import { followRoute } from "../router";
import { REPO_ISSUES_URL } from "../shared/links";

interface HelpLink {
  icon: LucideIcon;
  title: string;
  description: string;
  href: string;
  external: boolean;
  /** Setup tasks only an administrator can carry out. */
  adminOnly?: boolean;
}

interface HelpSection {
  title: string;
  blurb?: string;
  links: HelpLink[];
}

// Guides render in-app at /help/<name>, from the copy of docs/users/ that ships in
// the build — so they work with no internet and always match this version. The
// file name is kept as the argument (not the slug) because `check:ui` reads these
// calls to prove every guide in docs/users/ is listed here.
const guide = (file: string) => `/help/${file.replace(/\.md$/, "")}`;

// User-facing guides live in docs/users/ (see docs/users/README.md), so this list
// has to stay in step with that folder — check:ui fails when it doesn't.
const HELP_SECTIONS: HelpSection[] = [
  {
    title: "Getting started",
    blurb: "Taking a new install from a blank page to a working library.",
    links: [
      {
        icon: Rocket,
        title: "First run",
        description: "Creating the setup admin, signing in, and inviting the rest of the family.",
        href: guide("first-run.md"),
        external: false,
        adminOnly: true
      },
      {
        icon: HardDrive,
        title: "Storage",
        description:
          "The two things every install needs: somewhere for generated thumbnails, and the folders libraries may read.",
        href: guide("storage.md"),
        external: false,
        adminOnly: true
      },
      {
        icon: LibraryBig,
        title: "Setting up libraries",
        description: "The Add-library wizard, pointing a library at a folder, and what the first scan does.",
        href: guide("libraries.md"),
        external: false,
        adminOnly: true
      }
    ]
  },
  {
    title: "Your libraries",
    blurb: "How each kind of media is organised, and what you can do with it.",
    links: [
      {
        icon: Headphones,
        title: "Audiobooks",
        description: "How folders become books with chapters, and where your place is kept.",
        href: guide("library-audiobooks.md"),
        external: false
      },
      {
        icon: BookOpen,
        title: "Ebooks",
        description: "EPUB and PDF, the in-app reader, and books that come in more than one format.",
        href: guide("library-ebooks.md"),
        external: false
      },
      {
        icon: FileCog,
        title: "Scan rules",
        description: "Teaching the scanner a folder that is organised its own way — patterns, preview, and which rule wins.",
        href: guide("scan-rules.md"),
        external: false,
        adminOnly: true
      },
      {
        icon: Images,
        title: "Gallery",
        description: "Photos and videos, the timeline, albums, slideshows, and face recognition.",
        href: guide("library-gallery.md"),
        external: false
      },
      {
        icon: FolderTree,
        title: "Family tree",
        description: "Adding relatives, life events and photos, and letting someone edit their own branch.",
        href: guide("family-tree.md"),
        external: false
      },
      {
        icon: BookText,
        title: "Stories",
        description:
          "Writing a page from what the house already holds — chapters and their pages, narration, collections with their own access, reviews, and guest links.",
        href: guide("stories.md"),
        external: false
      }
    ]
  },
  {
    title: "Your account",
    links: [
      {
        icon: UserRound,
        title: "Your account",
        description:
          "Your name and sign-in email, themes, the e-reader address, and where likes, bookmarks, quotes and collections live.",
        href: guide("your-account.md"),
        external: false
      },
      {
        icon: Quote,
        title: "Quotes",
        description:
          "Passages you highlight while reading, famous lines, and the things your family says — plus the quote of the day, categories, and importing a pack.",
        href: guide("quotes.md"),
        external: false
      },
      {
        icon: Send,
        title: "Sharing with family",
        description:
          "One Send to button for everything — pass a book to someone, mail it to your own e-reader, or make a guest link — plus notes under a book, a photo or a person, and where the things people send you land.",
        href: guide("family-sharing.md"),
        external: false
      },
      {
        icon: KeyRound,
        title: "Passkeys",
        description:
          "Sign in with a fingerprint, face or PIN instead of a password — and why no one-time code is needed.",
        href: guide("passkeys.md"),
        external: false
      },
      {
        icon: ShieldCheck,
        title: "Two-factor authentication",
        description:
          "Add a one-time code to your sign-in, manage backup codes, and what to do if you're locked out.",
        href: guide("two-factor-authentication.md"),
        external: false
      },
      {
        icon: MonitorSmartphone,
        title: "Link a device",
        description:
          "Sign a TV, wall display or kiosk in by scanning a code with your phone — and how to remove one later.",
        href: guide("link-a-device.md"),
        external: false
      }
    ]
  },
  {
    title: "Running the server",
    links: [
      {
        icon: Settings,
        title: "The control panel",
        description: "A tour of every section: status, backups, security, labels, logs, scheduled jobs, and accounts.",
        href: guide("control-panel.md"),
        external: false,
        adminOnly: true
      },
      {
        icon: Trash2,
        title: "Duplicate cleanup",
        description: "Clearing out copied photos and folders, a saved job at a time — and what stops a delete going wrong.",
        href: guide("duplicate-cleanup.md"),
        external: false,
        adminOnly: true
      },
      {
        icon: Mail,
        title: "Setting up email",
        description: "The SMTP settings, what the server sends, and why a save-and-test usually fails the first time.",
        href: guide("email.md"),
        external: false,
        adminOnly: true
      },
      {
        icon: Wifi,
        title: "Exposing your library to the internet",
        description: "Putting it behind HTTPS, the settings to turn on first, and the risks to weigh.",
        href: guide("exposing-to-the-internet.md"),
        external: false,
        adminOnly: true
      },
      {
        icon: Bug,
        title: "Report a bug",
        description: "Found something broken or confusing? Open an issue on GitHub.",
        href: REPO_ISSUES_URL,
        external: true
      },
      {
        icon: Info,
        title: "About this app",
        description: "Version, what's new, and project details.",
        href: "/about",
        external: false
      }
    ]
  }
];

export function HelpPage({ user, logout }: { user: PublicUser; logout: () => Promise<void> }) {
  const isAdmin = user.role === "admin";
  // Setup guides describe the control panel, which members can't open — listing
  // them would only point at doors that aren't there.
  const sections = HELP_SECTIONS
    .map((section) => ({ ...section, links: section.links.filter((link) => isAdmin || !link.adminOnly) }))
    .filter((section) => section.links.length > 0);

  return (
    <DashboardShell active="help" user={user} logout={logout}>
      <section className="work-area help-area">
        <p className="eyebrow">Support</p>
        <h1>Help &amp; guides</h1>
        <p className="section-description">
          Friendly, task-focused guides for using and running iSputnik. They're part of this install,
          so they work without an internet connection and describe the version you're running.
        </p>

        {sections.map((section) => (
          <section className="help-section" key={section.title}>
            <h2 className="help-section-title">{section.title}</h2>
            {section.blurb && <p className="help-section-blurb">{section.blurb}</p>}

            <div className="help-card-list">
              {section.links.map(({ icon: Icon, title, description, href, external }) => {
                const inner = (
                  <>
                    <span className="help-card-icon" aria-hidden="true">
                      <Icon size={22} />
                    </span>
                    <span className="help-card-copy">
                      <strong>{title}</strong>
                      <span>{description}</span>
                    </span>
                    {external && <ExternalLink className="help-card-arrow" size={18} aria-hidden="true" />}
                  </>
                );
                return external ? (
                  <a className="help-card" key={title} href={href} target="_blank" rel="noreferrer">
                    {inner}
                  </a>
                ) : (
                  <a className="help-card" key={title} href={href} onClick={(event) => followRoute(event, href)}>
                    {inner}
                  </a>
                );
              })}
            </div>
          </section>
        ))}
      </section>
    </DashboardShell>
  );
}
