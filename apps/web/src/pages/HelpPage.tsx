import { BookOpen, Bug, ExternalLink, Info, type LucideIcon } from "lucide-react";
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
}

// User-facing guides live in docs/users/ (see docs/users/README.md). They open
// on GitHub rather than rendering in-app, matching how Security links its docs.
const HELP_LINKS: HelpLink[] = [
  {
    icon: BookOpen,
    title: "Two-factor authentication",
    description:
      "Add a one-time code to your sign-in, manage backup codes, and what to do if you get locked out.",
    href: repoFileUrl("docs/users/two-factor-authentication.md"),
    external: true
  },
  {
    icon: BookOpen,
    title: "Exposing your library to the internet",
    description: "For whoever runs the server: putting it behind HTTPS and the settings to set first.",
    href: repoFileUrl("docs/users/exposing-to-the-internet.md"),
    external: true
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
];

export function HelpPage({ user, logout }: { user: PublicUser; logout: () => Promise<void> }) {
  return (
    <DashboardShell active="help" user={user} logout={logout}>
      <section className="work-area help-area">
        <p className="eyebrow">Support</p>
        <h1>Help &amp; guides</h1>
        <p className="section-description">
          Friendly, task-focused guides for using and running iSputnik.
        </p>

        <div className="help-card-list">
          {HELP_LINKS.map(({ icon: Icon, title, description, href, external }) => {
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
    </DashboardShell>
  );
}
