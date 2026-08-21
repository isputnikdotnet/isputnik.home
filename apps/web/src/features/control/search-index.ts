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
  signins: "sign-in details login analytics drill down dive connection ip address country city user person failed attempts blocked scanner probes guessed names sessions devices displays phones tablets computers signed in until expires registered revoke sign out logout tokens linked tv display",
  dashboard: "system health cpu memory uptime version disk free space database sqlite activity trends charts graphs logins uploads downloads deletes played read viewed in progress playback reading libraries statistics stats numbers counts totals audiobook ebook gallery top authors narrators formats storage",
  tasks: "jobs job log scan progress worker queue running failed history",
  logs: "activity audit trail events sign-in history retention prune clear",

  libraries: "add library scan sources folders paths extensions uploads access members wizard rescan",
  storage: "thumbnails cache path containers approved folders disk location recycle bin trash folder",
  categories: "genres genre keywords mapping icons images taxonomy",
  tags: "labels rename merge taxonomy",

  users: "accounts people roles admin member password reset disable remove remote device link window allow outside away travel",
  groups: "shared access group membership permissions",
  invites: "invite signup sign-up registration link token new account",

  security: "posture summary proxy hops client ip mode overview",
  securityPolicies:
    "lockout brute force threshold attempts password minimum length complexity sign-in alerts email abuseipdb reputation abuse score threat intelligence read only readonly delete trusted network protect deletions",
  securityTrusted: "cidr subnet allowlist lan home network exempt whitelist",
  securityBlocked:
    "banned ip block unblock auto-block ban permanent never expires forever make permanent reputation abuseipdb abuse score check",

  backup: "restore zip archive download snapshot schedule retention export",
  scheduledJobs: "cron schedule nightly automatic recurring timer",
  recycleBin: "trash deleted restore purge retention undelete how long keep days cleanup expiry location folder path custom bin",
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
// `query` lands inside a page that keeps views in its query string (the
// Dashboard's tabs), so a search hit opens the right view, not the page's first.
const SETTING_ENTRIES: { title: string; section: ControlSection; keywords: string; query?: string }[] = [
  { title: "System health", section: "dashboard", query: "view=system", keywords: "sqlite wal database size bytes memory uptime free disk space version node last backup" },
  { title: "Library statistics", section: "dashboard", query: "view=libraries", keywords: "statistics stats numbers counts totals audiobook ebook gallery photos videos top authors narrators formats storage on disk biggest library" },
  { title: "Activity", section: "dashboard", query: "view=activity", keywords: "uploads downloads deletes played read viewed in progress content activity playback reading charts" },
  { title: "Locations map", section: "dashboard", query: "view=locations", keywords: "map countries towns cities where sign-ins came from geoip home location" },
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
    title: "Two-factor sign-in",
    section: "securityPolicies",
    keywords: "mfa 2fa require second factor outside trusted network force totp email code fallback remote"
  },
  {
    title: "Linking devices",
    section: "securityPolicies",
    keywords: "link a device tv television wall display kiosk qr code scan sign in without password home network only outside remote"
  },
  {
    title: "IP reputation (AbuseIPDB)",
    section: "securityPolicies",
    keywords: "abuseipdb api key reputation abuse confidence score escalate permanent known malicious"
  },
  {
    title: "Deletion protection",
    section: "securityPolicies",
    keywords: "allow deletions only trusted networks read only readonly refuse delete away from home stolen credentials"
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
    href: entry.query ? `${sectionHref(entry.section)}?${entry.query}` : sectionHref(entry.section),
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
