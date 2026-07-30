import {
  BookOpen, Bug, ExternalLink, FolderTree, HardDrive, Headphones, Images, Info, LibraryBig,
  Rocket, ShieldCheck, Wifi, type LucideIcon
} from "lucide-react";
import type { PublicUser } from "../api";
import { DashboardShell } from "../app/DashboardShell";
import { followRoute } from "../router";
import { REPO_ISSUES_URL, repoFileUrl } from "../shared/links";

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

const guide = (file: string) => repoFileUrl(`docs/users/${file}`);

// User-facing guides live in docs/users/ (see docs/users/README.md). They open on
// GitHub rather than rendering in-app, matching how Security links its docs — so
// this list has to stay in step with that folder's README.
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
        external: true,
        adminOnly: true
      },
      {
        icon: HardDrive,
        title: "Storage",
        description:
          "The two things every install needs: somewhere for generated thumbnails, and the folders libraries may read.",
        href: guide("storage.md"),
        external: true,
        adminOnly: true
      },
      {
        icon: LibraryBig,
        title: "Setting up libraries",
        description: "The Add-library wizard, pointing a library at a folder, and what the first scan does.",
        href: guide("libraries.md"),
        external: true,
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
        external: true
      },
      {
        icon: BookOpen,
        title: "Ebooks",
        description: "EPUB and PDF, the in-app reader, and books that come in more than one format.",
        href: guide("library-ebooks.md"),
        external: true
      },
      {
        icon: Images,
        title: "Gallery",
        description: "Photos and videos, the timeline, albums, slideshows, and face recognition.",
        href: guide("library-gallery.md"),
        external: true
      },
      {
        icon: FolderTree,
        title: "Family tree",
        description: "Adding relatives, life events and photos, and letting someone edit their own branch.",
        href: guide("family-tree.md"),
        external: true
      }
    ]
  },
  {
    title: "Your account",
    links: [
      {
        icon: ShieldCheck,
        title: "Two-factor authentication",
        description:
          "Add a one-time code to your sign-in, manage backup codes, and what to do if you're locked out.",
        href: guide("two-factor-authentication.md"),
        external: true
      }
    ]
  },
  {
    title: "Running the server",
    links: [
      {
        icon: Wifi,
        title: "Exposing your library to the internet",
        description: "Putting it behind HTTPS, the settings to turn on first, and the risks to weigh.",
        href: guide("exposing-to-the-internet.md"),
        external: true,
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
          Friendly, task-focused guides for using and running iSputnik. They open on GitHub, where
          they're kept up to date with the app.
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
