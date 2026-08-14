import { ALL_TABS, sectionEyebrow, sectionHref, sectionTitle } from "./nav";
import type { ControlSection } from "../../router";

// What the control-panel search can find. Two kinds of entry:
//
//   * one per tab, generated from CONTROL_GROUPS — so every page is reachable
//     by its own name without anyone maintaining a second list;
//   * named settings that live *inside* a page (SMTP host, lockout threshold,
//     thumbnail path…). These are the reason search exists: they used to be
//     three levels down with no way to find them but to remember where they were.
//
// `keywords` carries the words someone would actually type — the old name of a
// thing, the acronym, the unit — not a restatement of the title.

export interface ControlSearchEntry {
  /** Stable id, so React keys survive re-filtering. */
  id: string;
  title: string;
  /** Shown under the title: "Settings › Email". */
  breadcrumb: string;
  href: string;
  section: ControlSection;
  keywords: string;
}

// Extra search terms for the tab pages themselves.
const TAB_KEYWORDS: Partial<Record<ControlSection, string>> = {
  status: "system health cpu memory uptime version disk database sqlite integrity",
  stats: "statistics numbers counts totals audiobook ebook gallery top authors narrators formats largest biggest",
  tasks: "jobs job log scan progress worker queue running failed history",
  logs: "activity audit trail events sign-in history retention prune clear",

  libraries: "add library scan sources folders paths extensions uploads access members wizard rescan",
  storage: "thumbnails cache path containers approved folders disk location recycle bin trash folder",
  categories: "genres genre keywords mapping icons images taxonomy",
  tags: "labels rename merge taxonomy",

  users: "accounts people roles admin member password reset disable remove remote device link window allow outside away travel",
  groups: "shared access group membership permissions",
  invites: "invite signup sign-up registration link token new account",
  sessions: "devices signed in sign out revoke logout tokens linked tv display",

  security: "posture summary proxy hops client ip mode overview",
  securityPolicies: "lockout brute force threshold attempts password minimum length complexity sign-in alerts email",
  securityTrusted: "cidr subnet allowlist lan home network exempt whitelist",
  securityBlocked: "banned ip block unblock auto-block ban",

  backup: "restore zip archive download snapshot schedule retention export",
  scheduledJobs: "cron schedule nightly automatic recurring timer",
  recycleBin: "trash deleted restore purge retention undelete how long keep days cleanup expiry",
  missingPhotos: "gallery missing gone offline broken files photos videos",
  // Short labels now that they are views of Duplicates, so the words someone would
  // actually type have to be here — "duplicate photos" is no longer in the title.
  duplicateCleanup: "duplicate cleanup job wizard clean up duplicates saved job resume come back later owner one at a time keep clean folder rules review delete copies reclaim space scan libraries duplicate photos duplicate folders copies identical phash near-identical free space imported twice same folder twice keep photos in preferred folder already stored elsewhere contained copied into itself overlapping shared some photos partial copy",

  appearance: "theme default look colours colors dark light branding",
  email: "smtp mail relay server port tls starttls password sender from test",
  notifications: "notify email alerts members shared with me sharing switch on off opt in",
  readerAccess: "opds catalog token koreader thorium moon+ reader ereader e-reader basic auth device",
  about: "version credits licences licenses changelog release notes what's new"
};

// Settings that live inside a page. `section` is where they are; search takes
// you to that tab and the setting is on it.
const SETTING_ENTRIES: { title: string; section: ControlSection; keywords: string }[] = [
  { title: "Database size & integrity", section: "status", keywords: "sqlite wal vacuum bytes" },
  { title: "Log retention", section: "logs", keywords: "keep days delete old activity prune" },
  { title: "Thumbnail storage", section: "storage", keywords: "thumbnails cache folder path move" },
  { title: "Library containers", section: "storage", keywords: "approved allowed root folders mount" },
  { title: "Scan sources", section: "libraries", keywords: "folder path watch include exclude extensions" },
  { title: "Library access & members", section: "libraries", keywords: "who can see private share group user" },
  { title: "Account lockout", section: "securityPolicies", keywords: "failed attempts lock minutes brute force" },
  { title: "IP auto-block", section: "securityPolicies", keywords: "automatic ban failed window minutes" },
  { title: "Password policy", section: "securityPolicies", keywords: "minimum length complexity require strong" },
  { title: "New sign-in alerts", section: "securityPolicies", keywords: "email notify unknown network login" },
  {
    title: "Linking devices",
    section: "securityPolicies",
    keywords: "link a device tv television wall display kiosk qr code scan sign in without password home network only outside remote"
  },
  { title: "Add a trusted network", section: "securityTrusted", keywords: "cidr range lan skip lockout" },
  { title: "Scheduled backups", section: "backup", keywords: "automatic nightly keep how many retention" },
  { title: "Default theme", section: "appearance", keywords: "new members sign-in screen look" },
  { title: "SMTP server", section: "email", keywords: "host port username password tls outgoing mail" },
  { title: "Send a test email", section: "email", keywords: "verify smtp check delivery" },
  { title: "OPDS reader tokens", section: "readerAccess", keywords: "create token catalog link qr device" },
  { title: "Two-factor & security alerts delivery", section: "email", keywords: "mfa totp codes alert emails" },
  {
    title: "Share notifications",
    section: "notifications",
    keywords: "notify members when a photo book album is shared with them turn on enable share notification recipient"
  }
];

function breadcrumbFor(section: ControlSection): string {
  return `${sectionEyebrow(section)} › ${sectionTitle(section)}`;
}

export const CONTROL_SEARCH_ENTRIES: ControlSearchEntry[] = [
  ...ALL_TABS.map((tab) => ({
    id: `tab:${tab.section}`,
    title: tab.label,
    breadcrumb: sectionEyebrow(tab.section),
    href: sectionHref(tab.section),
    section: tab.section,
    keywords: `${sectionEyebrow(tab.section)} ${TAB_KEYWORDS[tab.section] ?? ""}`
  })),
  ...SETTING_ENTRIES.map((entry, index) => ({
    id: `setting:${index}`,
    title: entry.title,
    breadcrumb: breadcrumbFor(entry.section),
    href: sectionHref(entry.section),
    section: entry.section,
    keywords: entry.keywords
  }))
];

// Ranked substring match over title then keywords. Deliberately not fuzzy: with
// ~40 entries, typo-tolerance buys little and mostly surfaces confusing results.
// Multi-word queries must match every word somewhere, so "email test" works.
export function searchControlPanel(query: string): ControlSearchEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const scored: { entry: ControlSearchEntry; score: number }[] = [];

  for (const entry of CONTROL_SEARCH_ENTRIES) {
    const title = entry.title.toLowerCase();
    const haystack = `${title} ${entry.breadcrumb.toLowerCase()} ${entry.keywords.toLowerCase()}`;
    if (!words.every((word) => haystack.includes(word))) continue;

    // Prefer a title hit over a keyword-only hit, and a prefix over a mid-word one.
    let score = 0;
    for (const word of words) {
      if (title.startsWith(word)) score += 3;
      else if (title.includes(word)) score += 2;
      else score += 1;
    }
    scored.push({ entry, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title))
    .map((hit) => hit.entry);
}
